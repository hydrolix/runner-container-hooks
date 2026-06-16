import * as core from '@actions/core'
import * as k8s from '@kubernetes/client-node'
import { ContainerInfo, Registry } from 'hooklib'
import * as stream from 'stream'
import {
  getJobPodName,
  getRunnerPodName,
  getSecretName,
  getStepPodName,
  getVolumeClaimName,
  RunnerInstanceLabel
} from '../hooks/constants'
import {
  PodPhase,
  mergePodSpecWithOptions,
  mergeObjectMeta,
  useKubeScheduler,
  fixArgs,
  sleep
} from './utils'

const kc = new k8s.KubeConfig()

kc.loadFromDefault()

const DEFAULT_WAIT_FOR_POD_TIME_SECONDS = 10 * 60 // 10 min

export const POD_VOLUME_NAME = 'work'

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND'
])
const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000

export function isRetryableError(err: unknown): boolean {
  if (err instanceof k8s.HttpError && err?.statusCode !== undefined) {
    return RETRYABLE_STATUS_CODES.has(err?.statusCode)
  }

  let current: unknown = err
  while (current instanceof Error) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && RETRYABLE_NETWORK_CODES.has(code)) {
      return true
    }
    current = (current as { cause?: unknown }).cause
  }

  return false
}

function retryDelay(attempt: number): number {
  return RETRY_BASE_DELAY_MS * 2 ** attempt * (0.5 + Math.random())
}

export function retryAfterDelay(err: k8s.HttpError, attempt: number): number {
  const headerRetrySeconds =
    err.response?.headers?.['retry-after'] ??
    err.response?.headers?.['Retry-After']
  if (!headerRetrySeconds) {
    return retryDelay(attempt)
  }

  const seconds = Number(headerRetrySeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return retryDelay(attempt)
  }

  // Cap the delay to 30 seconds
  const maxDelaySeconds = 30
  return Math.min(seconds * 1000, maxDelaySeconds * 1000)
}

function describeError(err: unknown): string {
  if (err instanceof k8s.HttpError) {
    return `status ${err?.statusCode}`
  }
  let current: unknown = err
  while (current instanceof Error) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && RETRYABLE_NETWORK_CODES.has(code)) {
      return code
    }
    current = (current as { cause?: unknown }).cause
  }
  return String(err)
}

// WARNING: at-least-once delivery for writes.
//
// This proxy retries EVERY method on the wrapped client when isRetryableError
// returns true, including non-idempotent writes (createNamespaced*,
// patchNamespaced*, replaceNamespaced*). A 5xx from an intermediary or an
// ECONNRESET *after* the server has already committed a POST will cause a
// retry; on the next attempt the server returns 409 AlreadyExists, which then
// surfaces to the caller as a hard failure even though the original write
// succeeded.
//
// Every caller that POSTs/PUTs/PATCHes through this wrapped client MUST handle
// 409 explicitly (see createJobPod, createContainerStepPod, createDockerSecret,
// createSecretForEnvs for the existing call sites). If you add a new write
// caller and skip the 409s fallback, you will get spurious failures under
// transient network conditions.
export function withRetryClient<T extends object>(client: T): T {
  const callWithRetry = async (
    fn: (...args: unknown[]) => unknown,
    name: string,
    args: unknown[]
  ): Promise<unknown> => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn(...args)
      } catch (err) {
        if (!isRetryableError(err) || attempt === MAX_RETRIES) {
          throw err
        }
        const delay =
          err instanceof k8s.HttpError && err?.statusCode === 429
            ? retryAfterDelay(err, attempt)
            : retryDelay(attempt)
        core.warning(
          `K8s API call ${name} failed (${describeError(
            err
          )}), retrying in ${Math.round(delay)}ms (retry ${
            attempt + 1
          } of ${MAX_RETRIES})`
        )
        await sleep(delay)
      }
    }
  }

  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') {
        return value
      }
      return async (...args: unknown[]) =>
        callWithRetry(value.bind(target), String(prop), args)
    }
  })
}

const k8sApi = withRetryClient(kc.makeApiClient(k8s.CoreV1Api))
const k8sBatchV1Api = withRetryClient(kc.makeApiClient(k8s.BatchV1Api))
const k8sAuthorizationV1Api = withRetryClient(
  kc.makeApiClient(k8s.AuthorizationV1Api)
)

export const requiredPermissions = [
  {
    group: '',
    verbs: ['get', 'list', 'create', 'delete'],
    resource: 'pods',
    subresource: ''
  },
  {
    group: '',
    verbs: ['get', 'create'],
    resource: 'pods',
    subresource: 'exec'
  },
  {
    group: '',
    verbs: ['get', 'list', 'watch'],
    resource: 'pods',
    subresource: 'log'
  },
  {
    group: 'batch',
    verbs: ['get', 'list', 'create', 'delete'],
    resource: 'jobs',
    subresource: ''
  },
  {
    group: '',
    verbs: ['create', 'delete', 'get', 'list'],
    resource: 'secrets',
    subresource: ''
  }
]

export async function createPod(
  jobContainer?: k8s.V1Container,
  services?: k8s.V1Container[],
  registry?: Registry,
  extension?: k8s.V1PodTemplateSpec
): Promise<k8s.V1Pod> {
  const containers: k8s.V1Container[] = []
  if (jobContainer) {
    containers.push(jobContainer)
  }
  if (services?.length) {
    containers.push(...services)
  }

  const appPod = new k8s.V1Pod()

  appPod.apiVersion = 'v1'
  appPod.kind = 'Pod'

  appPod.metadata = new k8s.V1ObjectMeta()
  appPod.metadata.name = getJobPodName()

  const instanceLabel = new RunnerInstanceLabel()
  appPod.metadata.labels = {
    [instanceLabel.key]: instanceLabel.value
  }
  appPod.metadata.annotations = {}

  appPod.spec = new k8s.V1PodSpec()
  appPod.spec.containers = containers
  appPod.spec.restartPolicy = 'Never'

  const nodeName = await getCurrentNodeName()
  if (useKubeScheduler()) {
    appPod.spec.affinity = await getPodAffinity(nodeName)
  } else {
    appPod.spec.nodeName = nodeName
  }
  const claimName = getVolumeClaimName()
  appPod.spec.volumes = [
    {
      name: 'work',
      persistentVolumeClaim: { claimName }
    }
  ]

  if (registry) {
    const secret = await createDockerSecret(registry)
    if (!secret?.metadata?.name) {
      throw new Error(`created secret does not have secret.metadata.name`)
    }
    const secretReference = new k8s.V1LocalObjectReference()
    secretReference.name = secret.metadata.name
    appPod.spec.imagePullSecrets = [secretReference]
  }

  if (extension?.metadata) {
    mergeObjectMeta(appPod, extension.metadata)
  }

  if (extension?.spec) {
    mergePodSpecWithOptions(appPod.spec, extension.spec)
  }

  try {
    const { body } = await k8sApi.createNamespacedPod(namespace(), appPod)
    return body
  } catch (err) {
    if (err instanceof k8s.HttpError && err?.statusCode === 409) {
      const { body } = await k8sApi.readNamespacedPod(
        appPod.metadata.name,
        namespace()
      )
      return body
    }
    throw err
  }
}

export async function createJob(
  container: k8s.V1Container,
  extension?: k8s.V1PodTemplateSpec
): Promise<k8s.V1Job> {
  const runnerInstanceLabel = new RunnerInstanceLabel()

  const job = new k8s.V1Job()
  job.apiVersion = 'batch/v1'
  job.kind = 'Job'
  job.metadata = new k8s.V1ObjectMeta()
  job.metadata.name = getStepPodName()
  job.metadata.labels = { [runnerInstanceLabel.key]: runnerInstanceLabel.value }
  job.metadata.annotations = {}

  job.spec = new k8s.V1JobSpec()
  job.spec.ttlSecondsAfterFinished = 300
  job.spec.backoffLimit = 0
  job.spec.template = new k8s.V1PodTemplateSpec()

  job.spec.template.spec = new k8s.V1PodSpec()
  job.spec.template.metadata = new k8s.V1ObjectMeta()
  job.spec.template.metadata.labels = {}
  job.spec.template.metadata.annotations = {}
  job.spec.template.spec.containers = [container]
  job.spec.template.spec.restartPolicy = 'Never'

  const nodeName = await getCurrentNodeName()
  if (useKubeScheduler()) {
    job.spec.template.spec.affinity = await getPodAffinity(nodeName)
  } else {
    job.spec.template.spec.nodeName = nodeName
  }

  const claimName = getVolumeClaimName()
  job.spec.template.spec.volumes = [
    {
      name: 'work',
      persistentVolumeClaim: { claimName }
    }
  ]

  if (extension) {
    if (extension.metadata) {
      // apply metadata both to the job and the pod created by the job
      mergeObjectMeta(job, extension.metadata)
      mergeObjectMeta(job.spec.template, extension.metadata)
    }
    if (extension.spec) {
      mergePodSpecWithOptions(job.spec.template.spec, extension.spec)
    }
  }

  const { body } = await k8sBatchV1Api.createNamespacedJob(namespace(), job)
  return body
}

export async function getContainerJobPodName(jobName: string): Promise<string> {
  const selector = `job-name=${jobName}`
  const backOffManager = new BackOffManager(60)
  while (true) {
    const podList = await k8sApi.listNamespacedPod(
      namespace(),
      undefined,
      undefined,
      undefined,
      undefined,
      selector,
      1
    )

    if (!podList.body.items?.length) {
      await backOffManager.backOff()
      continue
    }

    if (!podList.body.items[0].metadata?.name) {
      throw new Error(
        `Failed to determine the name of the pod for job ${jobName}`
      )
    }
    return podList.body.items[0].metadata.name
  }
}

export async function deletePod(name: string): Promise<void> {
  try {
    await k8sApi.deleteNamespacedPod(name, namespace(), undefined, undefined, 0)
  } catch (err) {
    if (err instanceof k8s.HttpError && err?.statusCode === 404) {
      return
    }
    throw err
  }
}

export async function execPodStep(
  command: string[],
  podName: string,
  containerName: string,
  stdin?: stream.Readable
): Promise<void> {
  const exec = new k8s.Exec(kc)
  command = fixArgs(command)
  // Exec returns a websocket. If websocket fails, we should reject the promise. Otherwise, websocket will call a callback. Since at that point, websocket is not failing, we can safely resolve or reject the promise.
  await new Promise(function (resolve, reject) {
    exec
      .exec(
        namespace(),
        podName,
        containerName,
        command,
        process.stdout,
        process.stderr,
        stdin ?? null,
        false /* tty */,
        resp => {
          // kube.exec returns an error if exit code is not 0, but we can't actually get the exit code
          if (resp.status === 'Success') {
            resolve(resp.code)
          } else {
            core.debug(
              JSON.stringify({
                message: resp?.message,
                details: resp?.details
              })
            )
            reject(resp?.message)
          }
        }
      )
      // If exec.exec fails, explicitly reject the outer promise
      // eslint-disable-next-line github/no-then
      .catch(e => reject(e))
  })
}

export async function waitForJobToComplete(jobName: string): Promise<void> {
  const backOffManager = new BackOffManager()
  while (true) {
    try {
      if (await isJobSucceeded(jobName)) {
        return
      }
    } catch (error) {
      throw new Error(`job ${jobName} has failed`)
    }
    await backOffManager.backOff()
  }
}

export async function createDockerSecret(
  registry: Registry
): Promise<k8s.V1Secret> {
  const authContent = {
    auths: {
      [registry.serverUrl || 'https://index.docker.io/v1/']: {
        username: registry.username,
        password: registry.password,
        auth: Buffer.from(`${registry.username}:${registry.password}`).toString(
          'base64'
        )
      }
    }
  }

  const runnerInstanceLabel = new RunnerInstanceLabel()

  const secretName = getSecretName()
  const secret = new k8s.V1Secret()
  secret.immutable = true
  secret.apiVersion = 'v1'
  secret.metadata = new k8s.V1ObjectMeta()
  secret.metadata.name = secretName
  secret.metadata.namespace = namespace()
  secret.metadata.labels = {
    [runnerInstanceLabel.key]: runnerInstanceLabel.value
  }
  secret.type = 'kubernetes.io/dockerconfigjson'
  secret.kind = 'Secret'
  secret.data = {
    '.dockerconfigjson': Buffer.from(JSON.stringify(authContent)).toString(
      'base64'
    )
  }

  return await _createNamespacedSecret(secret, secretName)
}

async function _createNamespacedSecret(
  secret: k8s.V1Secret,
  secretName: string
): Promise<k8s.V1Secret> {
  try {
    const { body } = await k8sApi.createNamespacedSecret(namespace(), secret)

    return body
  } catch (err) {
    if (!(err instanceof k8s.HttpError && err?.statusCode === 409)) {
      throw err
    }
    // 409 here is almost certainly the retry-induced case: our POST committed
    // server-side, an intermediary returned 5xx / ECONNRESET, withRetryClient
    // retried, and the second attempt saw the secret we just created. Verify
    // the existing secret's data matches what we tried to write before
    // claiming success — otherwise the caller will mount stale env values.
    // Secrets are immutable (set above), so we cannot replace/patch on
    // mismatch; surface the collision instead.
    const { body } = await k8sApi.readNamespacedSecret(secretName, namespace())
    const existingData = body?.data ?? {}
    const desiredData = secret.data ?? {}
    const desiredKeys = Object.keys(desiredData)
    const existingKeys = Object.keys(existingData)
    const mismatch =
      desiredKeys.length !== existingKeys.length ||
      desiredKeys.some(k => existingData[k] !== desiredData[k])
    if (mismatch) {
      throw new Error(
        `secret ${secretName} already exists with data that does not match the requested envs; refusing to mount stale secret`
      )
    }

    return body
  }
}

export async function createSecretForEnvs(envs: {
  [key: string]: string
}): Promise<string> {
  const runnerInstanceLabel = new RunnerInstanceLabel()

  const secret = new k8s.V1Secret()
  const secretName = getSecretName()
  secret.immutable = true
  secret.apiVersion = 'v1'
  secret.metadata = new k8s.V1ObjectMeta()
  secret.metadata.name = secretName

  secret.metadata.labels = {
    [runnerInstanceLabel.key]: runnerInstanceLabel.value
  }
  secret.kind = 'Secret'
  secret.data = {}
  for (const [key, value] of Object.entries(envs)) {
    secret.data[key] = Buffer.from(value).toString('base64')
  }

  await _createNamespacedSecret(secret, secretName)

  return secretName
}

export async function deleteSecret(secretName: string): Promise<void> {
  try {
    await k8sApi.deleteNamespacedSecret(secretName, namespace())
  } catch (err) {
    if (err instanceof k8s.HttpError && err?.statusCode === 404) {
      return
    }
    throw err
  }
}

export async function pruneSecrets(): Promise<void> {
  const secretList = await k8sApi.listNamespacedSecret(
    namespace(),
    undefined,
    undefined,
    undefined,
    undefined,
    new RunnerInstanceLabel().toString()
  )
  if (!secretList.body.items.length) {
    return
  }

  await Promise.all(
    secretList.body.items.map(
      secret => secret.metadata?.name && deleteSecret(secret.metadata.name)
    )
  )
}

const UNRECOVERABLE_WAITING_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError'
])

function getContainerErrors(pod: k8s.V1Pod): string[] {
  const errors: string[] = []
  const allStatuses = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? [])
  ]
  for (const cs of allStatuses) {
    const waiting = cs.state?.waiting
    if (waiting?.reason && UNRECOVERABLE_WAITING_REASONS.has(waiting.reason)) {
      errors.push(
        `container "${cs.name}": ${waiting.reason}${
          waiting.message ? ` - ${waiting.message}` : ''
        }`
      )
    }
  }
  return errors
}

export async function waitForPodPhases(
  podName: string,
  awaitingPhases: Set<PodPhase>,
  backOffPhases: Set<PodPhase>,
  maxTimeSeconds = DEFAULT_WAIT_FOR_POD_TIME_SECONDS
): Promise<void> {
  const backOffManager = new BackOffManager(maxTimeSeconds)
  let phase: PodPhase = PodPhase.UNKNOWN
  try {
    while (true) {
      const pod = await readPod(podName)
      phase = parsePodPhase(pod)
      if (awaitingPhases.has(phase)) {
        return
      }

      if (!backOffPhases.has(phase)) {
        throw new Error(
          `Pod ${podName} is unhealthy with phase status ${phase}`
        )
      }

      const containerErrors = getContainerErrors(pod)
      if (containerErrors.length > 0) {
        throw new Error(
          `Pod ${podName} has unrecoverable container errors: ${containerErrors.join(
            '; '
          )}`
        )
      }

      await backOffManager.backOff()
    }
  } catch (error) {
    throw new Error(`Pod ${podName} is unhealthy with phase status ${phase}`)
  }
}

export function getPrepareJobTimeoutSeconds(): number {
  const envTimeoutSeconds =
    process.env['ACTIONS_RUNNER_PREPARE_JOB_TIMEOUT_SECONDS']

  if (!envTimeoutSeconds) {
    return DEFAULT_WAIT_FOR_POD_TIME_SECONDS
  }

  const timeoutSeconds = parseInt(envTimeoutSeconds, 10)
  if (!timeoutSeconds || timeoutSeconds <= 0) {
    core.warning(
      `Prepare job timeout is invalid ("${timeoutSeconds}"): use an int > 0`
    )
    return DEFAULT_WAIT_FOR_POD_TIME_SECONDS
  }

  return timeoutSeconds
}

async function readPod(name: string): Promise<k8s.V1Pod> {
  const result = await k8sApi.readNamespacedPod(name, namespace())

  return result?.body
}

const podPhaseLookup = new Set<string>([
  PodPhase.PENDING,
  PodPhase.RUNNING,
  PodPhase.SUCCEEDED,
  PodPhase.FAILED,
  PodPhase.UNKNOWN
])

function parsePodPhase(pod: k8s.V1Pod): PodPhase {
  if (!pod.status?.phase || !podPhaseLookup.has(pod.status.phase)) {
    return PodPhase.UNKNOWN
  }
  return pod.status.phase as PodPhase
}

async function isJobSucceeded(jobName: string): Promise<boolean> {
  const { body } = await k8sBatchV1Api.readNamespacedJob(jobName, namespace())
  const job = body
  if (job.status?.failed) {
    throw new Error(`job ${jobName} has failed`)
  }
  return !!job.status?.succeeded
}

export async function getPodLogs(
  podName: string,
  containerName: string
): Promise<void> {
  const log = new k8s.Log(kc)
  const logStream = new stream.PassThrough()
  logStream.on('data', chunk => {
    // use write rather than console.log to prevent double line feed
    process.stdout.write(chunk)
  })

  logStream.on('error', err => {
    process.stderr.write(err.message)
  })

  const r = await log.log(namespace(), podName, containerName, logStream, {
    follow: true,
    pretty: false,
    timestamps: false
  })
  await new Promise(resolve => r.on('close', () => resolve(null)))
}

export async function prunePods(): Promise<void> {
  const podList = await k8sApi.listNamespacedPod(
    namespace(),
    undefined,
    undefined,
    undefined,
    undefined,
    new RunnerInstanceLabel().toString()
  )
  if (!podList.body.items.length) {
    return
  }

  await Promise.all(
    podList.body.items.map(
      pod => pod.metadata?.name && deletePod(pod.metadata.name)
    )
  )
}

export async function getPodStatus(
  name: string
): Promise<k8s.V1PodStatus | undefined> {
  const { body } = await k8sApi.readNamespacedPod(name, namespace())
  return body.status
}

export async function isAuthPermissionsOK(): Promise<boolean> {
  const sar = new k8s.V1SelfSubjectAccessReview()
  const asyncs: Promise<{
    response: unknown
    body: k8s.V1SelfSubjectAccessReview
  }>[] = []
  for (const resource of requiredPermissions) {
    for (const verb of resource.verbs) {
      sar.spec = new k8s.V1SelfSubjectAccessReviewSpec()
      sar.spec.resourceAttributes = new k8s.V1ResourceAttributes()
      sar.spec.resourceAttributes.verb = verb
      sar.spec.resourceAttributes.namespace = namespace()
      sar.spec.resourceAttributes.group = resource.group
      sar.spec.resourceAttributes.resource = resource.resource
      sar.spec.resourceAttributes.subresource = resource.subresource
      asyncs.push(k8sAuthorizationV1Api.createSelfSubjectAccessReview(sar))
    }
  }
  const responses = await Promise.all(asyncs)
  return responses.every(resp => resp.body.status?.allowed)
}

export async function isPodContainerAlpine(
  podName: string,
  containerName: string
): Promise<boolean> {
  let isAlpine = true
  try {
    await execPodStep(
      [
        'sh',
        '-c',
        `'[ $(cat /etc/*release* | grep -i -e "^ID=*alpine*" -c) != 0 ] || exit 1'`
      ],
      podName,
      containerName
    )
  } catch (err) {
    isAlpine = false
  }

  return isAlpine
}

async function getCurrentNodeName(): Promise<string> {
  const resp = await k8sApi.readNamespacedPod(getRunnerPodName(), namespace())

  const nodeName = resp.body.spec?.nodeName
  if (!nodeName) {
    throw new Error('Failed to determine node name')
  }
  return nodeName
}

async function getPodAffinity(nodeName: string): Promise<k8s.V1Affinity> {
  const affinity = new k8s.V1Affinity()
  affinity.nodeAffinity = new k8s.V1NodeAffinity()
  affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution =
    new k8s.V1NodeSelector()
  affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms =
    [
      {
        matchExpressions: [
          {
            key: 'kubernetes.io/hostname',
            operator: 'In',
            values: [nodeName]
          }
        ]
      }
    ]
  return affinity
}

export function namespace(): string {
  if (process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']) {
    return process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  }

  const context = kc.getContexts().find(ctx => ctx.namespace)
  if (!context?.namespace) {
    throw new Error(
      'Failed to determine namespace, falling back to `default`. Namespace should be set in context, or in env variable "ACTIONS_RUNNER_KUBERNETES_NAMESPACE"'
    )
  }
  return context.namespace
}

class BackOffManager {
  private backOffSeconds = 1
  totalTime = 0
  constructor(private throwAfterSeconds?: number) {
    if (!throwAfterSeconds || throwAfterSeconds < 0) {
      this.throwAfterSeconds = undefined
    }
  }

  async backOff(): Promise<void> {
    await new Promise(resolve =>
      setTimeout(resolve, this.backOffSeconds * 1000)
    )
    this.totalTime += this.backOffSeconds
    if (this.throwAfterSeconds && this.throwAfterSeconds < this.totalTime) {
      throw new Error('backoff timeout')
    }
    if (this.backOffSeconds < 20) {
      this.backOffSeconds *= 2
    }
    if (this.backOffSeconds > 20) {
      this.backOffSeconds = 20
    }
  }
}

export function containerPorts(
  container: ContainerInfo
): k8s.V1ContainerPort[] {
  const ports: k8s.V1ContainerPort[] = []
  if (!container.portMappings?.length) {
    return ports
  }
  for (const portDefinition of container.portMappings) {
    const portProtoSplit = portDefinition.split('/')
    if (portProtoSplit.length > 2) {
      throw new Error(`Unexpected port format: ${portDefinition}`)
    }

    const port = new k8s.V1ContainerPort()
    port.protocol =
      portProtoSplit.length === 2 ? portProtoSplit[1].toUpperCase() : 'TCP'

    const portSplit = portProtoSplit[0].split(':')
    if (portSplit.length > 2) {
      throw new Error('ports should have at most one ":" separator')
    }

    const parsePort = (p: string): number => {
      const num = Number(p)
      if (!Number.isInteger(num) || num < 1 || num > 65535) {
        throw new Error(`invalid container port: ${p}`)
      }
      return num
    }

    if (portSplit.length === 1) {
      port.containerPort = parsePort(portSplit[0])
    } else {
      port.hostPort = parsePort(portSplit[0])
      port.containerPort = parsePort(portSplit[1])
    }

    ports.push(port)
  }
  return ports
}

export async function getPodByName(name): Promise<k8s.V1Pod> {
  const { body } = await k8sApi.readNamespacedPod(name, namespace())
  return body
}
