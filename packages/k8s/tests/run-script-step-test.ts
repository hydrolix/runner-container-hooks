import * as fs from 'fs'
import * as path from 'path'
import { cleanupJob, prepareJob, runScriptStep } from '../src/hooks'
import { TestHelper } from './test-setup'
import { PrepareJobArgs, RunScriptStepArgs } from 'hooklib'
import { execPodStep } from '../src/k8s'
import { JOB_CONTAINER_NAME } from '../src/hooks/constants'

jest.useRealTimers()

let testHelper: TestHelper

let prepareJobOutputData: any

let runScriptStepDefinition: {
  args: RunScriptStepArgs
}

describe('Run script step', () => {
  beforeEach(async () => {
    testHelper = new TestHelper()
    await testHelper.initialize()
    const prepareJobOutputFilePath = testHelper.createFile(
      'prepare-job-output.json'
    )

    const prepareJobData = testHelper.getPrepareJobDefinition()
    runScriptStepDefinition = testHelper.getRunScriptStepDefinition() as {
      args: RunScriptStepArgs
    }

    await prepareJob(
      prepareJobData.args as PrepareJobArgs,
      prepareJobOutputFilePath
    )
    const outputContent = fs.readFileSync(prepareJobOutputFilePath)
    prepareJobOutputData = JSON.parse(outputContent.toString())
  })

  afterEach(async () => {
    await cleanupJob()
    await testHelper.cleanup()
  })

  // NOTE: To use this test, do kubectl apply -f podspec.yaml (from podspec examples)
  // then change the name of the file to 'run-script-step-test.ts' and do
  // npm run test run-script-step

  it('should not throw an exception', async () => {
    await expect(
      runScriptStep(runScriptStepDefinition.args, prepareJobOutputData.state)
    ).resolves.not.toThrow()
  })

  it('should fail if the working directory does not exist', async () => {
    runScriptStepDefinition.args.workingDirectory = '/foo/bar'
    await expect(
      runScriptStep(runScriptStepDefinition.args, prepareJobOutputData.state)
    ).rejects.toThrow()
  })

  it('should shold have env variables available', async () => {
    runScriptStepDefinition.args.entryPoint = 'bash'

    runScriptStepDefinition.args.entryPointArgs = [
      '-c',
      "'if [[ -z $NODE_ENV ]]; then exit 1; fi'"
    ]
    await expect(
      runScriptStep(runScriptStepDefinition.args, prepareJobOutputData.state)
    ).resolves.not.toThrow()
  })

  it('Should have path variable changed in container with prepend path string', async () => {
    runScriptStepDefinition.args.prependPath = ['/some/path']
    runScriptStepDefinition.args.entryPoint = '/bin/bash'
    runScriptStepDefinition.args.entryPointArgs = [
      '-c',
      `'if [[ ! $(env | grep "^PATH=") = "PATH=${runScriptStepDefinition.args.prependPath}:"* ]]; then exit 1; fi'`
    ]

    await expect(
      runScriptStep(runScriptStepDefinition.args, prepareJobOutputData.state)
    ).resolves.not.toThrow()
  })

  it('Dollar symbols in environment variables should not be expanded', async () => {
    runScriptStepDefinition.args.environmentVariables = {
      VARIABLE1: '$VAR',
      VARIABLE2: '${VAR}',
      VARIABLE3: '$(VAR)'
    }
    runScriptStepDefinition.args.entryPointArgs = [
      '-c',
      '\'if [[ -z "$VARIABLE1" ]]; then exit 1; fi\'',
      '\'if [[ -z "$VARIABLE2" ]]; then exit 2; fi\'',
      '\'if [[ -z "$VARIABLE3" ]]; then exit 3; fi\''
    ]

    await expect(
      runScriptStep(runScriptStepDefinition.args, prepareJobOutputData.state)
    ).resolves.not.toThrow()
  })

  it('Should have path variable changed in container with prepend path string array', async () => {
    runScriptStepDefinition.args.prependPath = ['/some/other/path']
    runScriptStepDefinition.args.entryPoint = '/bin/bash'
    runScriptStepDefinition.args.entryPointArgs = [
      '-c',
      `'if [[ ! $(env | grep "^PATH=") = "PATH=${runScriptStepDefinition.args.prependPath.join(
        ':'
      )}:"* ]]; then exit 1; fi'`
    ]

    await expect(
      runScriptStep(runScriptStepDefinition.args, prepareJobOutputData.state)
    ).resolves.not.toThrow()
  })

  it('should sync _actions directory to pod before step execution', async () => {
    // Simulate runner downloading an action after prepareJob
    const workdir = path.dirname(process.env.RUNNER_WORKSPACE as string)
    const actionsDir = path.join(
      workdir,
      '_actions',
      'actions',
      'checkout',
      'v4'
    )
    fs.mkdirSync(actionsDir, { recursive: true })
    fs.writeFileSync(
      path.join(actionsDir, 'action.yml'),
      'name: checkout\nruns:\n  using: node20\n  main: dist/index.js\n'
    )

    // Run a step — _actions should be synced to pod at /__w/_actions/
    await runScriptStep(
      runScriptStepDefinition.args,
      prepareJobOutputData.state
    )

    // Verify the action file exists at the correct path in the pod
    await execPodStep(
      [
        'sh',
        '-c',
        '[ -f /__w/_actions/actions/checkout/v4/action.yml ] || exit 1'
      ],
      prepareJobOutputData.state.jobPod,
      JOB_CONTAINER_NAME
    ).then(output => {
      expect(output).toBe(0)
    })
  })

  it('should sync .github directory back to runner after step execution', async () => {
    const workdir = path.dirname(process.env.RUNNER_WORKSPACE as string)
    const githubWorkspace = process.env.GITHUB_WORKSPACE as string
    const parts = githubWorkspace.split('/').slice(-2)
    const repoDir = path.join(workdir, ...parts)

    // Create .github/actions in the pod to simulate post-checkout state
    await execPodStep(
      [
        'sh',
        '-c',
        'mkdir -p /__w/' +
          parts.join('/') +
          '/.github/actions/my-action && echo "name: test" > /__w/' +
          parts.join('/') +
          '/.github/actions/my-action/action.yml'
      ],
      prepareJobOutputData.state.jobPod,
      JOB_CONTAINER_NAME
    )

    // Run a step — .github should be synced back to runner
    await runScriptStep(
      runScriptStepDefinition.args,
      prepareJobOutputData.state
    )

    // Verify .github was copied back to the runner host
    const actionYml = path.join(
      repoDir,
      '.github',
      'actions',
      'my-action',
      'action.yml'
    )
    expect(fs.existsSync(actionYml)).toBe(true)
  })
})
