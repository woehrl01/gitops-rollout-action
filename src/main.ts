/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-console */
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

async function findOrCreateIssueWithLabel(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  label: string
): Promise<any> {
  const issue = await findIssueWithLabel(octokit, owner, repo, label)

  if (issue) {
    return issue
  }

  console.log(
    `No open issue found with the label "${label}". Creating a new one...`
  )

  const { data: newIssue } = await octokit.rest.issues.create({
    owner,
    repo,
    title: 'State Machine Issue',
    body: `<!-- STATE: ${JSON.stringify({})} -->`,
    labels: [label]
  })

  return newIssue
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



  //get all parts that have changed files
  const changedParts = config.parts.filter(part =>
    changedFiles.some((file: string) => minimatch(file, part.filePattern))
  )

  //get all issues that have a label of a changed part
  const issues = await Promise.all(
    changedParts.map(async part =>
      findOrCreateIssueWithLabel(
        octokit,
        github.context.repo.owner,
        github.context.repo.repo,
        part.name
      )
    )
  )

  //find all parts without an open issue
  const partsWithoutIssue = config.parts.filter(
    part =>
      !issues.some(issue =>
        issue.labels.some((label: { name: string }) => label.name === part.name)
      )
  )

  for (const part of partsWithoutIssue) {
    //create a new issue for the part
    const initalState = {
      number_of_rings: 0,
      current_ring: 0
    }

    copyInitialFiles(part)

    await octokit.rest.issues.create({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      title: `Rollout ${part.name}`,
      body: `<!-- STATE: ${JSON.stringify(initalState)} -->`,
      labels: [`part:${part.name}`]
    })
  }
}

async function copyInitialFiles(part: Part): Promise<void> {
  const target = path.join(part.target, '0')

  //copy all files from part.filePattern to part.target
  const files = await getFiles(part.filePattern)

  for (const file of files) {
    const targetFile = path.join(target, path.basename(file))

    console.log(`Copying ${file} to ${targetFile}`)

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

  const issues = await Promise.all(
    config.parts.map(async part =>
      findOrCreateIssueWithLabel(
        octokit,
        github.context.repo.owner,
        github.context.repo.repo,
        part.name
      )
    )
  )

  // Iterate over all issues
  for (const issue of issues) {
    // Get the state from the issue body
    const state = getStateFromBody(issue.body)

    // Get the part for the issue
    const part = config.parts.find(p =>
      issue.labels.some((label: { name: string }) => label.name === p.name)
    )

    if (!part) {
      throw new Error(`Could not find part for issue ${issue.number}`)
    }

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
        state: 'closed'
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
      console.log('Rollout is aborted. Skipping...')
      return currentState
    }

    if (flags.isPaused) {
      console.log('Rollout is paused. Skipping...')
      return currentState
    }

    if (flags.isFastlane) {
      console.log('Fastlane is enabled. increase ring...')
      return increaseRing(currentState, part)
    }

    const waitDuration = currentState.waitDurations[currentState.current_ring]
    const waitDurationInMs = parseGolangDuration(waitDuration)
    const timeSinceLastRollout =
      Date.now() - currentState.last_rollout_timestamp

    if (timeSinceLastRollout < waitDurationInMs) {
      console.log(
        `Not enough time has passed since last rollout. Wait for ${waitDuration} before rolling out to next ring.`
      )
      return currentState
    }

    return increaseRing(currentState, part)
  }

  return currentState
}

async function increaseRing(currentState: State, part: Part): Promise<State> {
  const currentRingLocation = `${part.target}/${currentState.current_ring}`
  const nextRingLocation = `${part.target}/${currentState.current_ring + 1}`

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
  // Create the destination directory if it doesn't exist
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true })
  }

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
  const issue = await findOrCreateIssueWithLabel(octokit, owner, repo, 'abc')

  const newBody = issue.body.replace(
    /<!-- STATE: (.*?) -->/,
    `<!-- STATE: ${JSON.stringify(newState)} -->`
  )

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
