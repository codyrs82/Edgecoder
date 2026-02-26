export type Language = "python" | "javascript";

export type QueueReasonCode =
  | "outside_subset"
  | "timeout"
  | "model_limit"
  | "manual";

export interface RunResult {
  language: Language;
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  queueForCloud: boolean;
  queueReason?: QueueReasonCode;
}

export interface IterationRecord {
  iteration: number;
  plan: string;
  code: string;
  runResult: RunResult;
}

export interface AgentExecution {
  plan: string;
  generatedCode: string;
  runResult: RunResult;
  iterations: number;
  history: IterationRecord[];
  escalated: boolean;
  escalationReason?: string;
}

export interface ExecutionPolicy {
  cpuCapPercent: number;
  memoryLimitMb: number;
  idleOnly: boolean;
  maxConcurrentTasks: number;
  allowedHours: {
    startHourUtc: number;
    endHourUtc: number;
  };
}

export type AgentMode = "swarm-only" | "ide-enabled";

export interface AgentRegistration {
  agentId: string;
  os: "debian" | "ubuntu" | "windows" | "macos" | "ios";
  version: string;
  mode: AgentMode;
  walletAccountId?: string;
}

export interface Subtask {
  id: string;
  taskId: string;
  kind: "micro_loop" | "single_step";
  language: Language;
  input: string;
  timeoutMs: number;
  snapshotRef: string;
  projectMeta: TaskProjectMeta;
  requestedModel?: string;
  dependsOn?: string[];
  subtaskIndex?: number;
}

export interface SubtaskResult {
  subtaskId: string;
  taskId: string;
  agentId: string;
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
  snapshotRef?: string;
  reportNonce?: string;
  reportSignature?: string;
}

export interface LocalModelManifest {
  modelId: string;
  sourceUrl: string;
  checksumSha256: string;
  signature: string;
  provider: "edgecoder-local" | "ollama-local";
}

export type ResourceClass = "cpu" | "gpu";
export type NetworkMode = "public_mesh" | "enterprise_overlay";

export interface TaskProjectMeta {
  projectId: string;
  tenantId?: string;
  resourceClass: ResourceClass;
  priority: number;
}

export interface MeshPeerIdentity {
  peerId: string;
  publicKeyPem: string;
  coordinatorUrl: string;
  networkMode: NetworkMode;
}

export type MeshMessageType =
  | "peer_announce"
  | "queue_summary"
  | "task_offer"
  | "task_claim"
  | "result_announce"
  | "ordering_snapshot"
  | "blacklist_update"
  | "issuance_proposal"
  | "issuance_vote"
  | "issuance_commit"
  | "issuance_checkpoint"
  | "capability_summary"
  | "peer_exchange"
  | "capability_announce";

export type MeshPeerRole = "coordinator" | "agent" | "phone";

export interface PeerExchangePayload {
  peers: Array<{
    peerId: string;
    publicKeyPem: string;
    peerUrl: string;
    networkMode: NetworkMode;
    role: MeshPeerRole;
    lastSeenMs: number;
  }>;
}

export interface CapabilityAnnouncePayload {
  peerId: string;
  role: MeshPeerRole;
  models: string[];
  maxConcurrentTasks: number;
  currentLoad: number;
  deviceType: "server" | "laptop" | "phone";
}

export interface MeshMessage {
  id: string;
  type: MeshMessageType;
  fromPeerId: string;
  issuedAtMs: number;
  ttlMs: number;
  payload: Record<string, unknown>;
  signature: string;
}

export interface QueueEventRecord {
  id: string;
  eventType:
    | "task_enqueue"
    | "task_claim"
    | "task_complete"
    | "task_requeue"
    | "node_approval"
    | "node_validation"
    | "earnings_accrual"
    | "stats_checkpoint_proposal"
    | "stats_checkpoint_signature"
    | "stats_checkpoint_commit";
  taskId: string;
  subtaskId?: string;
  actorId: string;
  sequence: number;
  issuedAtMs: number;
  prevHash: string;
  coordinatorId?: string;
  checkpointHeight?: number;
  checkpointHash?: string;
  payloadJson?: string;
  hash: string;
  signature: string;
}

export interface OrderingProof {
  recordId: string;
  hash: string;
  prevHash: string;
  sequence: number;
  signerPeerId: string;
}

export interface ComputeContributionReport {
  reportId: string;
  agentId: string;
  sourceAgentId?: string;
  taskId: string;
  resourceClass: ResourceClass;
  cpuSeconds: number;
  gpuSeconds: number;
  success: boolean;
  qualityScore: number;
  timestampMs: number;
}

export interface CreditTransaction {
  txId: string;
  accountId: string;
  type: "earn" | "spend" | "adjust" | "held";
  credits: number;
  reason: string;
  timestampMs: number;
  relatedTaskId?: string;
}

export interface CreditAccount {
  accountId: string;
  displayName: string;
  ownerUserId: string;
  createdAtMs: number;
}

export interface AccountMembership {
  accountId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  createdAtMs: number;
}

export interface AgentOwnership {
  agentId: string;
  accountId: string;
  ownerUserId: string;
  machineLabel?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface OllamaRolloutRecord {
  rolloutId: string;
  targetType: "coordinator" | "agent";
  targetId: string;
  provider: "edgecoder-local" | "ollama-local";
  model: string;
  autoInstall: boolean;
  status: "requested" | "in_progress" | "applied" | "failed";
  requestedBy: string;
  requestedAtMs: number;
  updatedAtMs: number;
  error?: string;
}

export type RolloutStage = "canary" | "batch" | "full" | "paused" | "rolled_back";

export interface RolloutPolicy {
  rolloutId: string;
  modelId: string;
  targetProvider: "ollama-local" | "edgecoder-local";
  stage: RolloutStage;
  canaryPercent: number;
  batchSize: number;
  batchIntervalMs: number;
  healthCheckRequired: boolean;
  autoPromote: boolean;
  rollbackOnFailurePercent: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type AgentRolloutStatus = "pending" | "downloading" | "applied" | "healthy" | "failed";

export interface AgentRolloutState {
  rolloutId: string;
  agentId: string;
  status: AgentRolloutStatus;
  modelVersion: string;
  updatedAtMs: number;
  error?: string;
}

export type BitcoinNetwork = "bitcoin" | "testnet" | "signet";
export type WalletType = "lightning" | "onchain";

export interface WalletAccount {
  accountId: string;
  walletType: WalletType;
  network: BitcoinNetwork;
  xpub?: string;
  lnNodePubkey?: string;
  payoutAddress?: string;
  encryptedSecretRef?: string;
  createdAtMs: number;
}

export interface PaymentIntent {
  intentId: string;
  accountId: string;
  coordinatorId: string;
  walletType: WalletType;
  network: BitcoinNetwork;
  invoiceRef: string;
  amountSats: number;
  coordinatorFeeBps: number;
  coordinatorFeeSats: number;
  netSats: number;
  quotedCredits: number;
  status: "created" | "settled" | "expired" | "cancelled";
  createdAtMs: number;
  settledAtMs?: number;
  txRef?: string;
}

export interface PriceEpochRecord {
  epochId: string;
  coordinatorId: string;
  resourceClass: ResourceClass;
  pricePerComputeUnitSats: number;
  supplyIndex: number;
  demandIndex: number;
  negotiatedWith: string[];
  signature: string;
  createdAtMs: number;
}

export interface RollingContributionShare {
  accountId: string;
  cpuSeconds: number;
  gpuSeconds: number;
  avgQualityScore: number;
  reliabilityScore: number;
  weightedContribution: number;
}

export interface IssuanceEpochRecord {
  issuanceEpochId: string;
  coordinatorId: string;
  windowStartMs: number;
  windowEndMs: number;
  loadIndex: number;
  dailyPoolTokens: number;
  hourlyTokens: number;
  totalWeightedContribution: number;
  contributionCount: number;
  finalized: boolean;
  createdAtMs: number;
}

export interface IssuanceAllocationRecord {
  allocationId: string;
  issuanceEpochId: string;
  accountId: string;
  weightedContribution: number;
  allocationShare: number;
  issuedTokens: number;
  createdAtMs: number;
}

export interface IssuancePayoutEvent {
  payoutEventId: string;
  issuanceEpochId: string;
  accountId: string;
  payoutType: "contributor" | "coordinator_service" | "reserve";
  tokens: number;
  sourceIntentId?: string;
  createdAtMs: number;
}

export interface QuorumVoteRecord {
  voterCoordinatorId: string;
  vote: "approve" | "reject";
  signature: string;
  votedAtMs: number;
}

export interface QuorumLedgerRecord {
  recordId: string;
  recordType: "issuance_proposal" | "issuance_vote" | "issuance_commit" | "issuance_checkpoint";
  epochId: string;
  coordinatorId: string;
  prevHash: string;
  hash: string;
  payloadJson: string;
  signature: string;
  createdAtMs: number;
}

export interface BitcoinAnchorRecord {
  anchorId: string;
  epochId: string;
  checkpointHash: string;
  anchorNetwork: BitcoinNetwork;
  txRef: string;
  status: "pending" | "anchored" | "failed";
  anchoredAtMs?: number;
  createdAtMs: number;
}

export interface CoordinatorFeeEvent {
  eventId: string;
  coordinatorId: string;
  intentId: string;
  feeWalletAccountId: string;
  feeSats: number;
  createdAtMs: number;
}

export interface TreasuryPolicy {
  policyId: string;
  treasuryAccountId: string;
  multisigDescriptor: string;
  quorumThreshold: number;
  totalCustodians: number;
  approvedCoordinatorIds: string[];
  keyRotationDays: number;
  status: "draft" | "active" | "retired";
  createdAtMs: number;
  updatedAtMs: number;
}

export interface KeyCustodyEvent {
  eventId: string;
  policyId: string;
  actorId: string;
  action: "create_policy" | "activate_policy" | "rotate_key" | "approve_release";
  details: string;
  signature: string;
  createdAtMs: number;
}

export interface BlacklistRecord {
  eventId: string;
  agentId: string;
  reason: string;
  reasonCode: BlacklistReasonCode;
  evidenceHashSha256: string;
  reporterId: string;
  reporterPublicKeyPem?: string;
  reporterSignature?: string;
  evidenceSignatureVerified: boolean;
  evidenceRef?: string;
  sourceCoordinatorId: string;
  reportedBy: string;
  timestampMs: number;
  expiresAtMs?: number;
  prevEventHash: string;
  eventHash: string;
  coordinatorSignature: string;
}

export type BlacklistReasonCode =
  | "abuse_spam"
  | "abuse_malware"
  | "policy_violation"
  | "credential_abuse"
  | "dos_behavior"
  | "forged_results"
  | "manual_review";

export interface PaymentReceipt {
  intentId: string;
  accountId: string;
  creditsMinted: number;
  coordinatorSignature: string;
  timestampMs: number;
}

// --- BLE Local Mesh Types ---

export interface BLEPeerEntry {
  agentId: string;
  meshTokenHash: string;
  accountId: string;
  model: string;
  modelParamSize: number;
  memoryMB: number;
  batteryPct: number;
  currentLoad: number;
  deviceType: "phone" | "laptop" | "workstation";
  rssi: number;
  lastSeenMs: number;
  taskSuccessCount?: number;
  taskFailCount?: number;
}

export interface BLETaskRequest {
  requestId: string;
  requesterId: string;
  task: string;
  language: Language;
  failedCode?: string;
  errorHistory?: string[];
  requesterSignature: string;
}

export interface BLETaskResponse {
  requestId: string;
  providerId: string;
  status: "completed" | "failed";
  generatedCode?: string;
  output?: string;
  cpuSeconds: number;
  providerSignature: string;
}

export interface BLECreditTransaction {
  txId: string;
  requesterId: string;
  providerId: string;
  requesterAccountId: string;
  providerAccountId: string;
  credits: number;
  cpuSeconds: number;
  taskHash: string;
  timestamp: number;
  requesterSignature: string;
  providerSignature: string;
}

/* ── Model Catalog & Swap ──────────────────────────────── */

export interface ModelCatalogEntry {
  modelId: string;
  displayName: string;
  paramSize: number;
  quantization: string;
  fileSizeBytes: number;
  downloadUrl: string;
  checksumSha256: string;
  platform: "ios" | "node" | "all";
  languages: string[];
  minMemoryMB: number;
}

export interface ModelSwapRequest {
  model: string;
}

export interface ModelSwapResponse {
  previous: string;
  active: string;
  status: "ready" | "pulling" | "error";
  paramSize: number;
  progress?: number;
  error?: string;
}

export interface ModelStatusResponse {
  model: string;
  paramSize: number;
  status: "ready" | "loading" | "error" | "no_model";
  ollamaHealthy: boolean;
  pullProgress?: number;
}

export interface ModelListEntry {
  modelId: string;
  paramSize: number;
  quantization?: string;
  installed: boolean;
  active: boolean;
  source: "ollama" | "cdn";
}

export type SandboxMode = "none" | "docker" | "vm";

export interface SandboxPolicy {
  required: boolean;          // Whether sandbox is mandatory
  allowedModes: SandboxMode[]; // Which sandbox modes are acceptable
  maxMemoryMB?: number;       // Memory limit for sandboxed execution
  maxCpuPercent?: number;     // CPU limit
  networkAccess?: boolean;    // Whether sandboxed code can access network
  timeoutMs?: number;         // Execution timeout override
}

export interface CapabilitySummaryPayload {
  coordinatorId: string;
  agentCount: number;
  modelAvailability: {
    [modelName: string]: {
      agentCount: number;
      totalParamCapacity: number;
      avgLoad: number;
    };
  };
  timestamp: number;
}
