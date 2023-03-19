/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as core from '@actions/core'
import * as fs from 'fs'
import * as github from '@actions/github'
import * as path from 'path'
import glob from 'glob'
import { minimatch } from 'minimatch'
import { execSync } from 'child_process'

async function run(): Promise<void> {
  try {
    const context = github.context
    const eventType = context.eventName

    if (eventType === 'schedule') {
      await handleSchedule()
    } else if (eventType === 'push') {
      await handlePush()
    } else {
      core.warning('This action is not configured to handle this event type.')
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
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


const config: Config = {
  parts: [
    {
      name: 'part1',
      filePattern: 'part1/**',
      target: 'generated/part1',
      waitDurations: ['5m', '10m', '15m']
    }
  ]
}

interface Config {
  parts: Part[]
}

interface Part {
  name: string
  filePattern: string
  target: string
  waitDurations: string[]
}

interface State {
  waitDurations: string[]
  last_rollout_timestamp: number
  current_ring: number
}

async function handlePush(): Promise<void> {
  const token = core.getInput('repo-token', { required: true })
  const octokit = github.getOctokit(token)

  const currentCommit = github.context.sha
  const parentCommit = github.context.payload.before

  // run shell command to get changed files
  const buffer = execSync(`git diff --name-only ${parentCommit} ${currentCommit}`)

  // convert buffer to string
  const changedFiles = buffer.toString().split('\n')

  core.info(`Changed files: ${changedFiles.join(', ')}`)

  //get all parts that have changed files
  const changedParts = config.parts.filter(part =>
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

  //find all parts without an open issue
  const partsWithoutIssue = partsWithIssue.filter(partWithIssue => partWithIssue.issue === null).map(partWithIssue => partWithIssue.part)


  for (const part of partsWithoutIssue) {

    core.info(`Initalize part ${part.name}`)
    //create a new issue for the part
    const initalState = {
      last_rollout_timestamp: Date.now(),
      waitDurations: part.waitDurations,
      current_ring: 0
    } as State

    copyInitialFiles(part)

    const issue = await octokit.rest.issues.create({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      title: `Rollout ${part.name}`,
      body: `<!-- STATE: ${JSON.stringify(initalState)} -->`,
      labels: [`part:${part.name}`, `ring:0/${part.waitDurations.length}`]
    })

    core.info(`Created issue ${issue.data.number} for part ${part.name}`)
  }
}

async function copyInitialFiles(part: Part): Promise<void> {
  const target = path.join(part.target, '0')

  //copy all files from part.filePattern to part.target
  const files = await getFiles(part.filePattern)

  for (const file of files) {
    if (fs.lstatSync(file).isDirectory()) {
      continue
    }

    const targetFile = path.join(target, path.basename(file))

    core.info(`Copying ${file} to ${targetFile}`)

    fs.mkdirSync(path.dirname(targetFile), { recursive: true })

    fs.copyFileSync(file, targetFile)
  }
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

async function handleSchedule(): Promise<void> {
  // Find all open issues of parts
  const token = core.getInput('repo-token', { required: true })
  const octokit = github.getOctokit(token)

  const partsWithIssues = await Promise.all(
    config.parts.map(async part => {
      return {
        part,
        issue: await findIssueWithLabel(
          octokit,
          github.context.repo.owner,
          github.context.repo.repo,
          `part:${part.name}`
        )
      }
    })
  )

  // Iterate over all issues
  for (const partWithIssue of partsWithIssues) {
    if (!partWithIssue.issue) {
      core.info(`No issue found for part ${partWithIssue.part.name}`)
      continue
    }

    const issue = partWithIssue.issue
    const part = partWithIssue.part

    // Get the state from the issue body
    const state = getStateFromBody(issue.body)

    const flags = getFlagsFromLabels(issue.labels)

    // Get the next state
    const newState = await getNextState(state, part, flags)

    // Only update the issue if the state has changed
    if (JSON.stringify(newState) !== JSON.stringify(state)) {
      await updateStateInBody(
        octokit,
        github.context.repo.owner,
        github.context.repo.repo,
        issue.number,
        newState,
        issue.labels
      )
    }

    // Close the issue if the state is finished
    if (isShouldCloseIssue(newState, flags)) {
      await octokit.rest.issues.update({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issue_number: issue.number,
        state: 'closed',
        state_reason: flags.isAborted ? 'not_planned' : 'completed'
      })
    }
  }
}

interface FlagsFromLabels {
  isFastlane: boolean
  isPaused: boolean
  isAborted: boolean
}

function isShouldCloseIssue(state: State, flags: FlagsFromLabels): boolean {
  if (flags.isAborted) {
    return true
  }
  return state.current_ring >= state.waitDurations.length
}

function getFlagsFromLabels(labels: { name: string }[]): FlagsFromLabels {
  return {
    isFastlane: labels.some(label => label.name === 'fastlane'),
    isPaused: labels.some(label => label.name === 'paused'),
    isAborted: labels.some(label => label.name === 'abort')
  }
}

async function getNextState(
  currentState: State,
  part: Part,
  flags: FlagsFromLabels
): Promise<any> {
  if (currentState.current_ring < currentState.waitDurations.length) {
    if (flags.isAborted) {
      core.info('Rollout is aborted. Skipping...')
      return currentState
    }

    if (flags.isPaused) {
      core.info('Rollout is paused. Skipping...')
      return currentState
    }

    if (flags.isFastlane) {
      core.info('Fastlane is enabled. increase ring...')
      return increaseRing(currentState, part)
    }

    const waitDuration = currentState.waitDurations[currentState.current_ring]
    const waitDurationInMs = parseGolangDuration(waitDuration)
    const timeSinceLastRollout =
      Date.now() - currentState.last_rollout_timestamp

    if (timeSinceLastRollout < waitDurationInMs) {
      core.info(
        `Not enough time has passed since last rollout. Wait for ${waitDuration} before rolling out to next ring.`
      )
      return currentState
    }

    core.info(`Wait duration of ${waitDuration} has passed. increase ring...`)

    return increaseRing(currentState, part)
  }

  return currentState
}

async function increaseRing(currentState: State, part: Part): Promise<State> {
  const currentRingLocation = `${part.target}/${currentState.current_ring}`
  const nextRingLocation = `${part.target}/${currentState.current_ring + 1}`

  core.info(`Copy files from ${currentRingLocation} to ${nextRingLocation}`)

  // Copy files from current ring to next ring
  await copyFolder(currentRingLocation, nextRingLocation)

  return {
    ...currentState,
    ...{
      last_rollout_timestamp: Date.now(),
      current_ring: currentState.current_ring + 1
    }
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
    fs.rmdirSync(dest, { recursive: true })
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
