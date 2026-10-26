import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { queueAuthorizationRequestSchema, queueAuthorizationSchema, type QueueAuthorization } from '@open-mercato/cezar-contract';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { queuePreview, readQueueState, updateQueue, type QueueState } from './queue.ts';
import { queueMockWorkflowRevision } from './mock-workflow.ts';
import { cezarHomeDir } from '../paths.ts';
import { freshGithubSnapshot, readGithubIssue, type GithubIssueReader } from './github-issue-verifier.ts';

const CHALLENGE_MS = 2 * 60_000;
const rpName = 'Cezar local owner approval';

function webAuthnOrigin(origin: string): { origin: string; rpId: string } {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Windows Hello approval requires the local loopback cockpit');
  }
  return { origin: url.origin, rpId: url.hostname };
}

function grantDigest(grant: Omit<QueueAuthorization, 'audit'>): Buffer {
  // Explicit field order is the approval protocol; no caller-supplied extra keys are signed.
  const value = [grant.repo, grant.repositoryRoot, grant.taskId, grant.taskRevision, grant.scope,
    grant.workflowRevision,
    grant.agent, grant.workflow, grant.expiresAt, grant.maxAttempts, grant.requireReview, grant.verificationCommand,
    grant.githubSnapshot && { repositoryId: grant.githubSnapshot.repositoryId, repositoryNodeId: grant.githubSnapshot.repositoryNodeId,
      issueId: grant.githubSnapshot.issueId, issueNodeId: grant.githubSnapshot.issueNodeId,
      issueNumber: grant.githubSnapshot.issueNumber, updatedAt: grant.githubSnapshot.updatedAt, digest: grant.githubSnapshot.digest }];
  return createHash('sha256').update(JSON.stringify(value)).digest();
}

function challengeFor(grant?: Omit<QueueAuthorization, 'audit'>): string {
  return Buffer.concat([randomBytes(32), grant ? grantDigest(grant) : Buffer.alloc(32)]).toString('base64url');
}

function assertGrantChallenge(challenge: string, grant: Omit<QueueAuthorization, 'audit'>): void {
  const raw = Buffer.from(challenge, 'base64url');
  if (raw.length !== 64 || !timingSafeEqual(raw.subarray(32), grantDigest(grant))) throw new Error('Approval challenge no longer matches its exact scope');
}

async function prepareGrant(input: unknown, issueReader: GithubIssueReader): Promise<Omit<QueueAuthorization, 'audit'>> {
  const request = queueAuthorizationRequestSchema.parse(input);
  const state = await readQueueState();
  const allowed = state.input.allowedRepositories.find((entry) => entry.repo.toLowerCase() === request.repo.toLowerCase());
  if (!allowed?.projectId) throw new Error('Repository is not explicitly allowlisted to a registered project');
  const workspace = await loadWorkspaceConfig();
  const project = workspace.projects.find((entry) => entry.id === allowed.projectId);
  if (!project) throw new Error('Allowlisted project is not registered');
  const row = queuePreview(state).rows.find((entry) => entry.repo.toLowerCase() === request.repo.toLowerCase() && entry.id.toLowerCase() === request.taskId.toLowerCase());
  if (!row || row.status !== 'ready') throw new Error('Task is not a ready queue candidate');
  const roadmap = state.input.roadmaps.find((entry) => (entry.githubIssue ? `${entry.repo}#${entry.githubIssue}` : entry.id).toLowerCase() === request.taskId.toLowerCase());
  if (!roadmap) throw new Error('A roadmap task with immutable local identity is required for this mock milestone');
  if (request.agent !== row.proposedAgent || request.workflow !== row.proposedWorkflow) throw new Error('Agent or workflow differs from the selected queue task');
  if (request.scope !== '.') throw new Error('Milestone 1C permits only the whole disposable repository scope (.)');
  if (request.verificationCommand !== 'cezar:mock-verify') throw new Error('Milestone 1C permits only the bundled mock verifier');
  if (request.maxAttempts > 3) throw new Error('Milestone 1C permits at most three mock attempts');
  if (Date.parse(request.expiresAt) <= Date.now()) throw new Error('Approval has already expired');
  const repositoryRoot = await realpath(project.root);
  if (!process.env.CEZ_HOME) throw new Error('An isolated CEZ_HOME is required for mock approval');
  const sandbox = await realpath(join(cezarHomeDir(), 'roadmap', 'disposable')).catch(() => undefined);
  const rel = sandbox ? relative(sandbox, repositoryRoot) : '..';
  if (!sandbox || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !existsSync(join(repositoryRoot, '.cezar-disposable'))) {
    throw new Error('Owner approval is limited to a marked disposable repository under CEZ_HOME/roadmap/disposable');
  }
  const taskRevision = createHash('sha256').update(JSON.stringify(roadmap)).digest('hex');
  const workflowRevision = queueMockWorkflowRevision(request.agent, request.maxAttempts);
  let githubSnapshot: QueueAuthorization['githubSnapshot'];
  if (roadmap.githubIssue !== undefined) {
    const cached = state.input.githubIssues.find((issue) => issue.repo.toLowerCase() === request.repo.toLowerCase() && issue.number === roadmap.githubIssue);
    if (!cached || cached.state !== 'open') throw new Error('Linked GitHub issue is missing or closed in the verified queue');
    const evidence = await issueReader(repositoryRoot, request.repo, roadmap.githubIssue);
    if (!freshGithubSnapshot(evidence.snapshot) || evidence.snapshot.issueNumber !== roadmap.githubIssue) throw new Error('Direct GitHub issue evidence is stale or mismatched');
    if (evidence.state !== 'open' || !evidence.labels.includes('roadmap-approved')) throw new Error('Linked GitHub issue is closed or lost its planning approval');
    if (cached.title !== evidence.title || [...cached.labels].sort().join('\0') !== [...evidence.labels].sort().join('\0')) {
      throw new Error('Linked GitHub issue changed since queue refresh');
    }
    githubSnapshot = evidence.snapshot;
  }
  return queueAuthorizationSchema.omit({ audit: true }).parse({ ...request, repositoryRoot, taskRevision, workflowRevision,
    ...(githubSnapshot ? { githubSnapshot } : {}) });
}

function consumeChallenge(state: QueueState, kind: 'enroll' | 'grant' | 'revoke', origin: string): NonNullable<QueueState['pendingOwnerChallenge']> {
  const pending = state.pendingOwnerChallenge;
  state.pendingOwnerChallenge = undefined;
  if (!pending || pending.kind !== kind || pending.origin !== origin || Date.parse(pending.expiresAt) <= Date.now()) {
    throw new Error('Owner challenge is missing, expired, or belongs to another origin');
  }
  return pending;
}

export async function beginOwnerEnrollment(originInput: string) {
  const { origin, rpId } = webAuthnOrigin(originInput);
  const state = await readQueueState();
  if (state.ownerAuthenticator) throw new Error('Owner credential is already enrolled');
  const challenge = challengeFor();
  const options = await generateRegistrationOptions({ rpName, rpID: rpId, userName: 'cezar-owner',
    userID: randomBytes(32), challenge: Buffer.from(challenge, 'base64url'), attestationType: 'none', supportedAlgorithmIDs: [-7, -257],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' } });
  await updateQueue((current) => {
    if (current.ownerAuthenticator) throw new Error('Owner credential is already enrolled');
    current.pendingOwnerChallenge = { kind: 'enroll', challenge, origin, rpId, expiresAt: new Date(Date.now() + CHALLENGE_MS).toISOString() };
  });
  return options;
}

export async function finishOwnerEnrollment(originInput: string, response: RegistrationResponseJSON): Promise<void> {
  const { origin } = webAuthnOrigin(originInput);
  let pending: NonNullable<QueueState['pendingOwnerChallenge']> | undefined;
  await updateQueue((state) => { pending = consumeChallenge(state, 'enroll', origin); });
  if (response.authenticatorAttachment !== 'platform') throw new Error('A Windows platform authenticator is required');
  const result = await verifyRegistrationResponse({ response, expectedChallenge: pending!.challenge,
    expectedOrigin: pending!.origin, expectedRPID: pending!.rpId, requireUserVerification: true });
  if (!result.verified || !result.registrationInfo?.userVerified) throw new Error('Windows Hello user verification was not cryptographically confirmed');
  const credential = result.registrationInfo.credential;
  await updateQueue((state) => {
    if (state.ownerAuthenticator) throw new Error('Owner credential was enrolled concurrently');
    state.ownerAuthenticator = { id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter, transports: credential.transports, enrolledAt: new Date().toISOString() };
  });
}

export async function beginOwnerGrant(originInput: string, input: unknown, issueReader: GithubIssueReader = readGithubIssue) {
  const { origin, rpId } = webAuthnOrigin(originInput);
  const grant = await prepareGrant(input, issueReader);
  const state = await readQueueState();
  if (!state.ownerAuthenticator) throw new Error('Windows Hello owner credential is unavailable');
  const challenge = challengeFor(grant);
  const options = await generateAuthenticationOptions({ rpID: rpId, challenge: Buffer.from(challenge, 'base64url'), userVerification: 'required',
    allowCredentials: [{ id: state.ownerAuthenticator.id, transports: state.ownerAuthenticator.transports as never }] });
  await updateQueue((current) => {
    if (current.ownerAuthenticator?.id !== state.ownerAuthenticator?.id) throw new Error('Owner credential changed');
    current.pendingOwnerChallenge = { kind: 'grant', challenge, origin, rpId, expiresAt: new Date(Date.now() + CHALLENGE_MS).toISOString(), grant };
  });
  return { options, grant };
}

export async function beginOwnerRevocation(originInput: string, repo: string, taskId: string) {
  const { origin, rpId } = webAuthnOrigin(originInput);
  const state = await readQueueState();
  if (!state.ownerAuthenticator) throw new Error('Windows Hello owner credential is unavailable');
  const previous = state.authorizations.find((entry) => entry.repo.toLowerCase() === repo.toLowerCase() && entry.taskId.toLowerCase() === taskId.toLowerCase());
  if (!previous || previous.revokedAt) throw new Error('Active authorization does not exist');
  const { audit: _audit, ...grant } = previous;
  const challenge = challengeFor(grant);
  const options = await generateAuthenticationOptions({ rpID: rpId, challenge: Buffer.from(challenge, 'base64url'), userVerification: 'required',
    allowCredentials: [{ id: state.ownerAuthenticator.id, transports: state.ownerAuthenticator.transports as never }] });
  await updateQueue((current) => {
    if (current.ownerAuthenticator?.id !== state.ownerAuthenticator?.id) throw new Error('Owner credential changed');
    current.pendingOwnerChallenge = { kind: 'revoke', challenge, origin, rpId, expiresAt: new Date(Date.now() + CHALLENGE_MS).toISOString(), grant };
  });
  return options;
}

export async function finishOwnerDecision(originInput: string, kind: 'grant' | 'revoke', response: AuthenticationResponseJSON, issueReader: GithubIssueReader = readGithubIssue): Promise<QueueAuthorization> {
  const { origin } = webAuthnOrigin(originInput);
  let pending: NonNullable<QueueState['pendingOwnerChallenge']> | undefined;
  let credential: NonNullable<QueueState['ownerAuthenticator']> | undefined;
  await updateQueue((state) => { pending = consumeChallenge(state, kind, origin); credential = state.ownerAuthenticator; });
  if (!pending!.grant || !credential || response.id !== credential.id) throw new Error('Owner credential or exact grant is missing');
  assertGrantChallenge(pending!.challenge, pending!.grant);
  const result = await verifyAuthenticationResponse({ response, expectedChallenge: pending!.challenge,
    expectedOrigin: pending!.origin, expectedRPID: pending!.rpId, requireUserVerification: true,
    credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey, 'base64url'), counter: credential.counter,
      transports: credential.transports as never } });
  if (!result.verified || !result.authenticationInfo.userVerified) throw new Error('Windows Hello approval signature or user verification failed');
  let authorized: QueueAuthorization | undefined;
  await updateQueue(async (state) => {
    if (state.ownerAuthenticator?.id !== credential!.id || state.ownerAuthenticator.counter !== credential!.counter) throw new Error('Owner credential changed during approval');
    if (kind === 'grant') {
      const current = await prepareGrant(pending!.grant, issueReader);
      if (!timingSafeEqual(grantDigest(current), grantDigest(pending!.grant!))) throw new Error('Task scope changed after owner verification');
    }
    const index = state.authorizations.findIndex((entry) => entry.repo.toLowerCase() === pending!.grant!.repo.toLowerCase() && entry.taskId.toLowerCase() === pending!.grant!.taskId.toLowerCase());
    const previous = state.authorizations[index];
    if (kind === 'revoke' && (!previous || previous.revokedAt)) throw new Error('Authorization is already revoked');
    const now = new Date().toISOString();
    authorized = queueAuthorizationSchema.parse({ ...pending!.grant, credentialId: credential!.id,
      approvedAt: kind === 'grant' ? now : previous?.approvedAt,
      revokedAt: kind === 'revoke' ? now : undefined,
      audit: [...(previous?.audit ?? []), { at: now, action: kind === 'revoke' ? 'revoked' : previous ? 'modified' : 'created', actor: 'windows-hello' }], });
    if (index < 0) state.authorizations.push(authorized); else state.authorizations[index] = authorized;
    state.ownerAuthenticator!.counter = result.authenticationInfo.newCounter;
  });
  return authorized!;
}
