/* eslint-disable import/named */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as core from '@actions/core'
import * as fs from 'fs'
import * as github from '@actions/github'
import * as path from 'path'
import glob from 'glob'
import { simpleGit, SimpleGit } from 'simple-git'
import { minimatch } from 'minimatch'
import dedent from 'dedent-js'
import { parse } from 'yaml'
import { spawnSync } from 'child_process'

interface InputConfig {
  title: string
  token: string
  commitMessage: string,
  config: Config
}

async function run(): Promise<void> {
  try {
    const context = github.context
    const eventType = context.eventName

    core.info(`Event type: ${eventType}`)

    const inputConfig = getInputConfig()

    if (eventType === 'schedule' || eventType === 'workflow_dispatch' || eventType === 'repository_dispatch') {
      await handleTick(inputConfig)
    } else if (eventType === 'push') {
      await handlePush(inputConfig)
    } else {
      core.warning('This action is not configured to handle this event type.')
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

function getInputConfig(): InputConfig {

  const configPath = core.getInput('config-file', { required: true })

  const configFileContent = fs.readFileSync(configPath, 'utf8')

  return {
    title: core.getInput('title', { required: true }),
    token: core.getInput('token', { required: true }),
    commitMessage: core.getInput('commit-message', { required: true }),
    config: parse(configFileContent) as Config
  }
}

// Helper function to find an open issue with a specific label
async function findIssueWithLabel(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  label: string
): Promise<any> {
  const { data: issues } = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    labels: label,
    state: 'open'
  })

  return issues.length > 0 ? issues[0] : null
}

const git: SimpleGit = simpleGit()

interface Config {
  rollouts: Rollout[]
}

interface Rollout {
  name: string
  filePattern: string
  target: string
  duplicateHandling: string
  waitDurations: string[]
  validateScript?: string
  validateScriptRetries?: number
}

interface State {
  waitDurations: string[]
  lastRolloutTimestamp: number
  current_ring: number
  sourceSha: string
  abort?: boolean
  abortReason?: string
  validateScriptRetries?: number
  lastValidateScriptResult?: string
}

async function handlePush(inputConfig: InputConfig): Promise<void> {
  const octokit = github.getOctokit(inputConfig.token)

  const currentCommit = github.context.sha
  const parentCommit = github.context.payload.before

  const changedFiles = (await git.diff(['--name-only', parentCommit, currentCommit])).split('\n')

  core.info(`Changed files: ${changedFiles.join(', ')}`)

  //get all parts that have changed files
  const changedParts = inputConfig.config.rollouts.filter(part =>
    changedFiles.some((file: string) => minimatch(file, part.filePattern))
  )

  core.info(`Changed parts: ${changedParts.map(part => part.name)}`)

  if (changedParts.length === 0) {
    core.info('No changed parts found. Nothing to do.')
    return
  }

  //get all issues that have a label of a changed part
  const partsWithIssue = await Promise.all(
    changedParts.map(async part => {
      return {
        part,
        issue: await findIssueWithLabel(
          octokit,
          github.context.repo.owner,
          github.context.repo.repo,
          `part:${part.name}`
        )
      }
    }
    )
  )




  const changedIssues: number[] = []
  for (const partWithIssue of partsWithIssue) {
    const part = partWithIssue.part

    const isAbortHandling = part.duplicateHandling === 'abort'

    if (partWithIssue.issue && isAbortHandling) {
      core.info(`Found existing issue ${partWithIssue.issue.number} for part ${part.name}. Recreating it.`)

      //close the issue
      await octokit.rest.issues.update({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issue_number: partWithIssue.issue.number,
        state: 'closed',
        state_reason: 'not_planned'
      })
    }

    core.info(`Initialize part ${part.name}`)

    const files = await copyInitialFiles(part, currentCommit)

    const readableBodyText = dedent(`
    This issue is dedicated to tracking the automated rollout of \`${part.name}\`.

    The rollout is divided into ${part.waitDurations.length} rings, executed within the following timeframes:

    ${part.waitDurations.map((duration, index) => `- Ring ${index + 1}: ${duration}`).join('\n')}

    The rollout is considered complete when all rings are active. Progress is monitored using issue labels, which include:

    - \`abort\`: Aborts the rollout
    - \`pause\`: Pauses the rollout
    - \`fasttrack\`: Advances the rollout to the next ring on the next tick

    ---

    The files impacted by this rollout are:

    ${files.map(file => `- \`${file}\``).join('\n')}

    ---

    Initiation commit: ${currentCommit}
    
    `)

    const initalState: State = {
      lastRolloutTimestamp: Date.now(),
      waitDurations: part.waitDurations,
      current_ring: 0,
      sourceSha: currentCommit
    }

    const title = inputConfig.title

    const issueTitle = title.replace('{name}', part.name)

    const issue = await octokit.rest.issues.create({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      title: issueTitle,
      body: `${readableBodyText} <!-- STATE: ${JSON.stringify(initalState)} -->`,
      labels: [`part:${part.name}`, `ring:0/${part.waitDurations.length}`, 'rollout']
    })

    changedIssues.push(issue.data.number)

    core.info(`Created issue ${issue.data.number} for part ${part.name}`)

    if (partWithIssue.issue && isAbortHandling) {
      //add a comment to the issue
      await octokit.rest.issues.createComment({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issue_number: partWithIssue.issue.number,
        body: `This rollout has been recreated as #${issue.data.number}`
      })
    }
  }

  if (changedIssues.length > 0) {
    await commitAndPush(inputConfig, changedIssues)
  }
}

async function copyInitialFiles(part: Rollout, commitSha: string): Promise<string[]> {
  const target = path.join(part.target, '0')

  const files = await getFiles(part.filePattern)

  const copiedFiles: string[] = []

  for (const file of files) {
    if (fs.lstatSync(file).isDirectory()) {
      continue
    }

    const targetFile = path.join(target, path.basename(file))

    core.info(`Copying ${file} to ${targetFile}`)

    fs.mkdirSync(path.dirname(targetFile), { recursive: true })

    fs.copyFileSync(file, targetFile)

    copiedFiles.push(targetFile)
  }

  fs.writeFileSync(path.join(target, '.commit'), commitSha)

  return copiedFiles
}

async function getFiles(pattern: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    glob(pattern, (err: any, files: string[]) => {
      if (err) {
        reject(err)
      } else {
        resolve(files)
      }
    })
  })
}

async function commitAndPush(inputConfig: InputConfig, changedIssues: number[]): Promise<void> {
  core.info(`Committing and pushing changes`)

  const status = await git.status()
  if (status.files.length === 0) {
    core.info('No changes to commit')
    return
  }

  await git.addConfig('user.name', 'github-actions[bot]')
  await git.addConfig('user.email', 'github-actions[bot]@users.noreply.github.com')

  await git.add('.')

  const commitMessage = inputConfig.commitMessage

  await git.commit(commitMessage.replace('{issues}', changedIssues.map(issue => `#${issue}`).join(', ')))

  for (const retry of [1, 2, 3]) {
    try {
      await git.push()
      break
    } catch (error) {
      if (retry === 3) {
        throw error
      }
      core.info(`Push failed. execute rebase pull and retry...`)
      await git.pull({ '--rebase': 'true' })
    }
  }

  core.info(`Committed and pushed changes`)
}

async function handleTick(inputConfig: InputConfig): Promise<void> {
  const octokit = github.getOctokit(inputConfig.token)

  const { data: allOpenRolloutIssues } = await octokit.rest.issues.listForRepo({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    state: 'open',
    labels: 'rollout'
  })

  //sort ascending by issue number
  allOpenRolloutIssues.sort((a, b) => a.number - b.number)

  // Iterate over all issues
  const changedIssues: number[] = []
  for (const issue of allOpenRolloutIssues) {

    const labels = (issue.labels || []) as { name: string }[]

    // Get the part name from the issue
    const part = getPartFromLabels(inputConfig.config.rollouts, labels)

    // Get the state from the issue body
    const state = getStateFromBody(issue.body || '')

    const flags = getFlagsFromLabels(labels)

    // Get the next state
    const newState = await getNextState(state, part, flags)

    let lastValidateScriptResult = newState.lastValidateScriptResult
    newState.lastValidateScriptResult = undefined // remove this from the state

    if (lastValidateScriptResult) {
      lastValidateScriptResult = dedent(`
        ---
        \`\`\`bash
        ${lastValidateScriptResult}
        \`\`\`
      `)
    } else {
      lastValidateScriptResult = ''
    }

    // Only update the issue if the state has changed
    if (JSON.stringify(newState) !== JSON.stringify(state)) {
      changedIssues.push(issue.number)

      core.info(`Updating issue ${issue.number} for part ${part.name}`)

      await updateStateInBody(
        octokit,
        github.context.repo.owner,
        github.context.repo.repo,
        issue.number,
        newState,
        labels
      )

      if (newState.abort) {
        core.info(`Rollout aborted for issue ${issue.number} for part ${part.name}`)

        await octokit.rest.issues.createComment({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          issue_number: issue.number,
          body: dedent(`
            Rollout aborted: ${newState.abortReason}
            ${lastValidateScriptResult}
          `)
        })

      } else {
        core.info(`Rollout advanced to next ring for part ${part.name}`)

        // comment on the issue
        await octokit.rest.issues.createComment({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          issue_number: issue.number,
          body: dedent(`
            Rollout advanced to ring ${newState.current_ring}/${newState.waitDurations.length}
            ${lastValidateScriptResult}
          `)
        })
      }
    }

    core.info(`Checking if issue ${issue.number} should be closed`)

    // Close the issue if the state is finished
    const shouldClose = isShouldCloseIssue(newState, flags)
    if (shouldClose.yes) {
      await octokit.rest.issues.update({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issue_number: issue.number,
        state: 'closed',
        state_reason: shouldClose.reason
      })
    }
  }

  if (changedIssues.length > 0) {
    await commitAndPush(inputConfig, changedIssues)
  }
}

interface FlagsFromLabels {
  isFastlane: boolean
  isPaused: boolean
  isAborted: boolean
  isIgnoreValidation: boolean
}

interface ShouldCloseResponse {
  yes: boolean
  reason: string
}

function getPartFromLabels(parts: Rollout[], labels: { name: string }[]): Rollout {
  const partLabel = labels.find(label => label.name.startsWith('part:'))
  if (!partLabel) {
    throw new Error('No part label found')
  }

  const partName = partLabel.name.replace('part:', '')

  const part = parts.find(p => p.name === partName)
  if (!part) {
    throw new Error(`Part ${partName} not found`)
  }

  return part
}

function isShouldCloseIssue(state: State, flags: FlagsFromLabels): ShouldCloseResponse {
  if (flags.isAborted) {
    return { yes: true, reason: 'not_planned' }
  }

  if (state.current_ring >= state.waitDurations.length) {
    return { yes: true, reason: 'completed' }
  }

  if (state.abort ?? false) {
    return { yes: true, reason: 'not_planned' }
  }

  return { yes: false, reason: '' }
}

function getFlagsFromLabels(labels: { name: string }[]): FlagsFromLabels {
  return {
    isFastlane: labels.some(label => label.name === 'fastlane'),
    isPaused: labels.some(label => label.name === 'paused'),
    isAborted: labels.some(label => label.name === 'abort'),
    isIgnoreValidation: labels.some(label => label.name === 'ignore-validation')
  }
}

async function getNextState(
  currentState: State,
  part: Rollout,
  flags: FlagsFromLabels
): Promise<State> {
  if (currentState.current_ring < currentState.waitDurations.length) {
    if (flags.isAborted) {
      core.info('Rollout is aborted. Skipping...')
      return {
        ...currentState,
        abort: true,
        abortReason: 'Aborted by user'
      }
    }

    if (flags.isPaused) {
      core.info('Rollout is paused. Skipping...')
      return currentState
    }

    if (flags.isFastlane) {
      core.info('Fastlane is enabled. increase ring...')
    } else {
      const waitDuration = currentState.waitDurations[currentState.current_ring]
      const waitDurationInMs = parseGolangDuration(waitDuration)
      const timeSinceLastRollout =
        Date.now() - currentState.lastRolloutTimestamp

      if (timeSinceLastRollout < waitDurationInMs) {
        core.info(
          `Not enough time has passed since last rollout. Wait for ${waitDuration} before rolling out to next ring.`
        )
        return currentState
      }

      core.info(`Wait duration of ${waitDuration} has passed. increase ring...`)
    }

    if (part.validateScript && part.validateScript.length > 0 && !flags.isIgnoreValidation) {
      // run validation script as bash and check if it returns 0
      const result = spawnSync('bash', ['-c', part.validateScript])
      const output = result.output.toString()

      if (result.status !== 0) {
        if ((currentState.validateScriptRetries) || 0 >= (part.validateScriptRetries || 0)) {
          core.info(`Validation script failed. Retry...`)
          return {
            ...currentState,
            validateScriptRetries: (currentState.validateScriptRetries || 0) + 1,
            lastValidateScriptResult: output
          }
        }

        core.warning(`Validation script failed. Abort...`)
        return {
          ...currentState,
          abort: true,
          abortReason: `Validation script failed.`
        }
      }


      core.info(`Validation script succeeded.`)
      core.info(`Output: ${output}`)
      return {
        ...increaseRing(currentState, part),
        lastValidateScriptResult: output
      }
    } else if (flags.isIgnoreValidation) {
      core.info(`Validation script ignored.`)
    } else {
      core.info(`No validation script found.`)
    }

    return increaseRing(currentState, part)
  }

  return currentState
}

async function increaseRing(currentState: State, part: Rollout): Promise<State> {
  const currentRingLocation = `${part.target}/${currentState.current_ring}`
  const nextRingLocation = `${part.target}/${currentState.current_ring + 1}`

  core.info(`Copy files from ${currentRingLocation} to ${nextRingLocation}`)

  // read currents ring commit
  const commitSha = fs.readFileSync(`${currentRingLocation}/.commit`, 'utf8')

  if (commitSha !== currentState.sourceSha) {
    core.warning(`Source commit ${currentState.sourceSha} does not match current ring commit ${commitSha}. Abort...`)
    return {
      ...currentState,
      abort: true,
      abortReason: `Source commit ${currentState.sourceSha} does not match current ring commit ${commitSha}. There must be another rollout for this part in the fastlane.`
    }
  }

  // Copy files from current ring to next ring
  await copyFolder(currentRingLocation, nextRingLocation)

  return {
    ...currentState,
    lastRolloutTimestamp: Date.now(),
    current_ring: currentState.current_ring + 1
  }
}

async function copyFolder(src: string, dest: string): Promise<void> {
  // check if source folder exists
  if (fs.existsSync(src) === false) {
    core.info(`Source folder ${src} does not exist`)
    return
  }

  // clear destination folder
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true })
  }

  fs.mkdirSync(dest, { recursive: true })

  // Read the source directory
  const entries = fs.readdirSync(src, { withFileTypes: true })

  // Iterate through the entries and handle files and directories separately
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      // If the entry is a directory, call the copyFolder function recursively
      await copyFolder(srcPath, destPath)
    } else {
      // If the entry is a file, copy the file
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// Helper function to extract state from issue body
function getStateFromBody(body: string): any {
  const match = body.match(/<!-- STATE: (.*?) -->/)
  return match ? JSON.parse(match[1]) : null
}

// Helper function to update state in issue body
async function updateStateInBody(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumber: number,
  newState: State,
  currentLabels: { name: string }[]
): Promise<void> {

  const { data: issue } = await octokit.rest.issues.get({
    owner,
    repo,
    issue_number: issueNumber
  })

  if (!issue) {
    throw new Error(`Could not find issue ${issueNumber}`)
  }

  let newBody = ''
  if (!issue.body) {
    newBody = `<!-- STATE: ${JSON.stringify(newState)} -->`
  } else {
    newBody = issue.body.replace(
      /<!-- STATE: (.*?) -->/,
      `<!-- STATE: ${JSON.stringify(newState)} -->`
    )
  }

  const keepLabels = currentLabels.filter(
    label => !label.name.startsWith('ring:')
  )

  await octokit.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    body: newBody,
    labels: [
      `ring:${newState.current_ring}/${newState.waitDurations.length}`,
      ...keepLabels
    ]
  })
}

function parseGolangDuration(durationStr: string): number {
  const durationRegex = /(\d+(\.\d+)?)([a-z]+)/g
  let totalMilliseconds = 0

  let match: RegExpExecArray | null

  while ((match = durationRegex.exec(durationStr)) !== null) {
    const value = parseFloat(match[1])
    const unit = match[3]

    switch (unit) {
      case 'ns':
        totalMilliseconds += value * 1e-6
        break
      case 'us':
        totalMilliseconds += value * 0.001
        break
      case 'ms':
        totalMilliseconds += value
        break
      case 's':
        totalMilliseconds += value * 1000
        break
      case 'm':
        totalMilliseconds += value * 1000 * 60
        break
      case 'h':
        totalMilliseconds += value * 1000 * 60 * 60
        break
      default:
        throw new Error(
          `Unknown unit "${unit}" in duration string "${durationStr}"`
        )
    }
  }

  return totalMilliseconds
}

run()
