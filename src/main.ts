/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/semi */
/* eslint-disable no-console */
/* eslint-disable prettier/prettier */
import * as core from '@actions/core'
import * as github from '@actions/github'
import { assign, createMachine, interpret } from 'xstate'

const machine = createMachine<{
  issueNumber: number
  persist: boolean
  currentState: string
  number_of_rings: number
  current_ring: number,
  last_ring_deployment_timestamp: number
}>({
  id: 'stateMachine',
  initial: "initial",
  context: {
    issueNumber: 0,
    persist: false,
    currentState: '',
    number_of_rings: 4,
    current_ring: 0,
    last_ring_deployment_timestamp: 0
  },
  states: {
    initial: {
      on: {
        activate: [{
          target: "#stateMachine.new_ring_deployment",
          cond: "is_matching"
        }, "skip"]
      }
    },

    new_ring_deployment: {
      entry: "start_new_ring_deployment",
      on: {
        start: "next_ring",

        create_issue: {
          target: "new_ring_deployment",
          internal: true
        }
      }
    },

    next_ring: {
      entry: "start_next_ring",
      on: {
        tick: [
          {
            actions: assign({
              current_ring: (context) => {
                if (Date.now() - context.last_ring_deployment_timestamp > 1000 * 60 * 5) {
                  return context.current_ring + 1
                }
                return context.current_ring
              }
            }),

            target: "next_ring",
            internal: true,
            cond: "has_next_ring"
          },
          "complete"
        ],

        fast_lane: "complete",
        abort: "deploy_stopped"
      }
    },

    deploy_stopped: {
      entry: "stop_deployment"
    },

    complete: {
      entry: "complete_deployment",
      type: "final"
    },

    skip: {
      type: "final"
    }
  }
}, {
  guards: {
    has_next_ring: (context) => context.current_ring < context.number_of_rings
  },
  actions: {
    start_next_ring: (context) => {
      console.log(`starting ring ${context.current_ring} of ${context.number_of_rings}...`)
    },
    start_new_ring_deployment: () => {
      console.log(`starting new ring deployment...`)
    },
    stop_deployment: () => {
      console.log(`stopping deployment...`)
    },
    complete_deployment: () => {
      console.log(`deployment complete!`)
    }
  }
})

async function run(): Promise<void> {
  try {
    const context = github.context
    const eventType = context.eventName

    if (eventType === 'schedule') {
      await handleSchedule()
    } else if (eventType === 'push') {
      await handlePush()
    } else if (eventType === 'issues') {
      const action = context.payload.action
      if (action === 'labeled' || action === 'unlabeled') {
        await handleWorkitemLabel()
      }
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
    state: 'open',
  });

  return issues.length > 0 ? issues[0] : null;
}

async function findOrCreateIssueWithLabel(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  label: string
): Promise<any> {
  const issue = await findIssueWithLabel(octokit, owner, repo, label);

  if (issue) {
    return issue;
  }

  console.log(`No open issue found with the label "${label}". Creating a new one...`);

  const { data: newIssue } = await octokit.rest.issues.create({
    owner,
    repo,
    title: 'State Machine Issue',
    body: `<!-- STATE: ${JSON.stringify({})} -->`,
    labels: [label],
  });

  return newIssue;
}

async function handlePush(): Promise<void> {
  return handle(service => service.send('initial'));
}

async function handleSchedule(): Promise<void> {
  return handle(service => service.send('tick'));
}

async function handleWorkitemLabel(): Promise<void> {
  // Your previous code for handling workitem Label actions
}

async function handle(action: (service: any) => {}): Promise<void> {
  const token = core.getInput('repo-token', { required: true });
  const octokit = github.getOctokit(token);

  const issue = await findIssueWithLabel(octokit, github.context.repo.owner, github.context.repo.repo, 'abc');
  let persistetState = null;
  if (!issue) {
    console.log('No open issue found with the label "abc"');
    persistetState = {
      currentState: 'inactive',
      counter: 0,
    };
  } else {
    persistetState = getStateFromBody(issue.body);
  }

  const service = interpret(machine)
    .onTransition((state) => {
      console.log(`State changed to ${state.value}`);
    })
    .start(persistetState.currentState);

  action(service);

  service.stop();

  const newState = service.getSnapshot()

  await updateStateInBody(octokit, github.context.repo.owner, github.context.repo.repo, issue.number, newState);
}

// Helper function to extract state from issue body
function getStateFromBody(body: string): any {
  const match = body.match(/<!-- STATE: (.*?) -->/);
  return match ? JSON.parse(match[1]) : null;
}

// Helper function to update state in issue body
async function updateStateInBody(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumber: number,
  newState: any
): Promise<void> {

  const issue = await findOrCreateIssueWithLabel(octokit, owner, repo, 'abc')

  const newBody = issue.body.replace(
    /<!-- STATE: (.*?) -->/,
    `<!-- STATE: ${JSON.stringify(newState)} -->`
  );

  await octokit.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    body: newBody,
    labels: ['abc', `ring:${newState.current_ring}/${newState.number_of_rings}`],
  });
}

run()
