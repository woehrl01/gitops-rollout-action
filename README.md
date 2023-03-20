# GitOps Rollout Action

This GitHub Action is designed to automate GitOps deployments using GitHub issues to track the rollout state. It's suitable for managing deployments of kustomize or Kubernetes manifests, or any other file-based configuration. The action commits files directly to the main branch, and generating pull requests is not currently supported.

## Overview

Upon a push event, the action identifies the changed files and initiates a new rollout for each affected part, based on your configuration. Each rollout is divided into rings, with ring 0 generated immediately when the rollout starts. Note that ring 0 cannot be removed. The rollout progresses through each ring according to the specified wait durations, with its state tracked in a dedicated GitHub issue.

The action should be configured to run on push events to track files and initiate new rollouts. Additionally, it should run on a schedule to provide the tick needed for rollouts to progress. For handling duplicate rollouts, two options are available: 'abort' and 'queue'. The 'abort' option aborts the previous rollout for a specific part, while the 'queue' option starts a second rollout following the first one. To prevent rollouts from overtaking each other, ".commit" files are generated in the rollout folder structure, indicating which ring originates from which commit.

## Configuration

The action is configured using a YAML file, which defines the parts, file patterns, targets, and wait durations. Here's an example:

```yaml
rollouts:
  - name: part1
    filePattern: part1/**
    target: generated/part1
    waitDurations:
      - '5m'
      - '10m'
      - '15m'
```

## Rollout Rings

The rollout is divided into rings, starting with ring 0, which is generated immediately upon starting the rollout. Each subsequent ring is activated based on the specified wait durations. The state of the rollout is tracked using GitHub issues and labels.

**Note:** Ring 0 is always present and cannot be removed.

## Tick Interval Limitations

Due to GitHub Actions limitations, the minimum tick interval is 5 minutes, and ticks may not run at exact time intervals. If you require a shorter interval, you can use a `repository_dispatch` event triggered from an external cron source instead of a scheduled GitHub Action.

## Usage

1. Set up the action in your GitHub repository by creating a new `.github/workflows` directory and adding a workflow file (e.g., `gitops_rollout.yml`) with the following content:

```yaml
on:
  push:
    branches:
      - main
  schedule:
    - cron: '*/5 * * * *' # adjust the frequency as needed

jobs:
  gitops_rollout:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v2
        with:
          fetch-depth: 0

      - name: Run GitOps Rollout Action
        uses: woehrl01/gitops-rollout-action@main # replace with the correct path to the action
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          config-file: path/to/your/config.yml # replace with the path to your configuration file
```

1. Configure the action according to your needs, adjusting the `config_path`, `duplicate_handling`, and other settings as necessary.
2. Commit and push the changes to your repository. The action will start monitoring for changes and initiate rollouts as configured.

For more information on how to set up and configure the action, refer to the [source code](https://chat.openai.com/chat/src/index.ts) and [example configuration](https://chat.openai.com/chat/example-config.yml).

## Additional Features

### Rollout Control

During a rollout, you can control its progress using issue labels. The following labels are available:

- `abort`: Aborts the rollout.
- `pause`: Pauses the rollout.
- `fasttrack`: Advances the rollout to the next ring on the next tick.

These labels can be added or removed from the associated GitHub issue to control the rollout behavior.

### Commit and Push

The GitOps Rollout Action automatically commits and pushes changes directly to the main branch. This ensures the repository stays up-to-date with the current state of the rollout. The action is configured to use the `github-actions[bot]` as the commit author.

## Limitations

- The action only supports committing and pushing changes directly to the main branch. Generating pull requests is not supported at this time.
- Due to GitHub Actions limitations, the minimum tick interval is 5 minutes, and ticks may not run at exact time intervals. If you require a shorter interval, you can use a `repository_dispatch` event triggered from an external cron source instead of a scheduled GitHub Action.

## Contributing

Contributions to the GitOps Rollout Action are welcome! Please feel free to open issues or submit pull requests with bug fixes or new features.

## License

This project is licensed under the [MIT License](https://chat.openai.com/chat/LICENSE).
