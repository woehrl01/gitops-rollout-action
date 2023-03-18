/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/semi */
/* eslint-disable no-console */
/* eslint-disable prettier/prettier */
import * as core from '@actions/core'
import * as github from '@actions/github'
import { assign, createMachine, interpret } from 'xstate'

const machine = createMachine<{
  issueNumber: number
  currentState: string
  number_of_rings: number
  current_ring: number
}>({
  /** @xstate-layout N4IgpgJg5mDOIC5SwC4EMVgLJoMYAsBLAOzADoTCVC0AbAYgEEBhAFQEkA1R1gUQG0ADAF1EoAA4B7WFUKTiYkAA9EARgDMAVjKrBATgAsggwHYDmvepOaATABoQATzV7BZdQDY9Jk3oAcHqaCFgC+IQ6oGNh4RKRkpADuAPoATiRQSRBg4rSSjgC2YMQo9JEpKEKiSCBSMtTyiioImh5+ZDaC6oJ+gp0eqqqGDs4Ig26e3r4BQaHhIJGYOAQk5KRKKKnp9NS4ANaVirWyDdVNHoE6vh62Jn5+NgN+w4h+qmQGep8mDwaqmgH+MIRdCLGIreJgdabYhQbaEPb8VRVCTSY4KU4vAJkQQmTr-TQWGwtZ6jVQ2Mh6TTqXSCGy3AyBP5A+Yg6LLOJrDZpGH0NAAI0k5UgB2qR3q6NATTuHmxuK0fgJeiJHhJDz0ZDljxs-haxhMYTmxEkWXg1QWbNiYEOqPFjUQAFoVU4HR5mealpaKMRZHRrXU5BLlIgDPZnaNXGQAT5-IFcbNgVEPeDEtCMlkcnlCsU-Wi7Qg6W8TNdAg9VEX1H49CTVB4TO4vLcWhXqQY-G7WUmOZCuekc7aMQhztoFZZbgqi-8TNX7u8qWS-mruj524mwXF07lHElUJJxOJIH2A3ndBGlXpWjZ+rX-k8w4MZZqbEZvjXRyvQezyLhJPkcmBMIeJySmo+huGeF5XtYdwkncGqdLo6iIVoRiaKoBohEAA */
  id: 'stateMachine',
  initial: "initial",
  context: {
    issueNumber: 0,
    currentState: '',
    number_of_rings: 4,
    current_ring: 0
  },
  states: {
    initial: {
      on: {
        ACTIVATE: "#stateMachine.new_ring_deployment"
      }
    },

    new_ring_deployment: {
      entry: "start_new_ring_deployment",
      on: {
        start: "next_ring"
      }
    },

    next_ring: {
      entry: "start_next_ring",
      on: {
        tick: [{
          actions: assign({
            current_ring: (context) => context.current_ring + 1
          }),

          target: "next_ring",
          internal: true,
          cond: "has_next_ring"
        }, "complete"],

        aborted: "deploy_stopped"
      }
    },

    deploy_stopped: {
      entry: "stop_deployment"
    },

    complete: {
      entry: "complete_deployment",
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

async function handlePush(): Promise<void> {
  return handle((service, state) => service.send({ type: 'INIT', ...state }));
}

async function handleSchedule(): Promise<void> {
  return handle((service, state) => service.send({ type: 'TICK', ...state }));
}

async function handleWorkitemLabel(): Promise<void> {
  // Your previous code for handling workitem Label actions
}

async function handle(action: (service: any, state: any) => {}): Promise<void> {
  const token = core.getInput('repo-token', { required: true });
  const octokit = github.getOctokit(token);

  const issue = await findIssueWithLabel(octokit, github.context.repo.owner, github.context.repo.repo, 'abc');
  if (!issue) {
    console.log('No open issue found with the label "abc"');
    return;
  }

  const state = getStateFromBody(issue.body);
  const service = interpret(machine).start(state.currentState);

  action(service, state);

  await updateStateInBody(octokit, github.context.repo.owner, github.context.repo.repo, issue.number, {
    currentState: service.getSnapshot(),
    counter: service.getSnapshot().context.current_ring,
  });
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
  state: any
): Promise<void> {
  const currentState = getStateFromBody(state.body);
  const newState = { ...currentState, ...state };

  const newBody = state.body.replace(
    /<!-- STATE: (.*?) -->/,
    `<!-- STATE: ${JSON.stringify(newState)} -->`
  );

  await octokit.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    body: newBody,
  });
}

run()
