import Foundation

struct PortalUser: Codable, Equatable {
    let userId: String
    let email: String
    let emailVerified: Bool
}

struct AuthResponse: Codable {
    let ok: Bool
    let user: PortalUser?
}

struct WalletOnboardingStatus: Codable {
    let accountId: String
    let network: String
    let createdAtMs: Double
    let acknowledgedAtMs: Double?
}

struct WalletGuidance: Codable {
    let title: String
    let steps: [String]
}

struct WalletOnboardingSignupPayload: Codable {
    let created: Bool
    let accountId: String
    let network: String
    let seedPhrase: String?
    let guidance: WalletGuidance?
}

struct SignupResponse: Codable {
    let ok: Bool
    let userId: String
    let emailVerification: String
    let walletOnboarding: WalletOnboardingSignupPayload?
}

struct DashboardPayload: Codable {
    struct UserPayload: Codable {
        let userId: String
        let email: String
        let emailVerified: Bool
    }

    struct ContributionPayload: Codable {
        let earnedCredits: Double
        let contributedTaskCount: Int
    }

    struct NodePayload: Codable, Identifiable {
        var id: String { nodeId }
        let nodeId: String
        let nodeKind: String
        let active: Bool
        let nodeApproved: Bool
        let lastSeenMs: Double?
    }

    let user: UserPayload
    let contribution: ContributionPayload
    let nodes: [NodePayload]
    let walletSnapshot: WalletSnapshotPayload?
    let networkSummary: NetworkSummaryPayload?
}

struct AgentContributionPayload: Codable {
    struct NodePayload: Codable {
        let active: Bool
        let nodeApproved: Bool
        let lastSeenMs: Double?
    }

    struct ContributionPayload: Codable {
        let earnedCredits: Double
        let contributedTaskCount: Int
    }

    struct WalletPayload: Codable {
        let accountId: String
        let balance: Double
        let estimatedSats: Int
        let satsPerCredit: Int
    }

    struct RuntimePayload: Codable {
        let connected: Bool
        let health: String?
        let mode: String?
        let localModelProvider: String?
        let maxConcurrentTasks: Int?
        let swarmEnabled: Bool?
        let ideEnabled: Bool?
    }

    let agentId: String
    let node: NodePayload
    let contribution: ContributionPayload
    let wallet: WalletPayload
    let runtime: RuntimePayload?
    let recentTaskIds: [String]
}

struct WalletSnapshotPayload: Codable {
    struct CreditsPayload: Codable {
        let accountId: String?
        let balance: Double?
    }

    struct QuotePayload: Codable {
        let estimatedSats: Int?
        let satsPerCredit: Int?
    }

    struct CreditHistoryItem: Codable {
        let transactionId: String?
        let type: String?
        let credits: Double?
        let reason: String?
        let relatedTaskId: String?
        let timestampMs: Double?
    }

    let credits: CreditsPayload?
    let quote: QuotePayload?
    let creditHistory: [CreditHistoryItem]?
}

struct NetworkSummaryPayload: Codable {
    let generatedAt: Double?
    let capacity: CapacityPayload?
    let status: StatusPayload?

    struct CapacityPayload: Codable {
        let totals: TotalsPayload?
    }

    struct TotalsPayload: Codable {
        let totalCapacity: Int?
        let agentsConnected: Int?
    }

    struct StatusPayload: Codable {
        let queued: Int?
        let results: Int?
        let agents: Int?
    }
}

struct EnrollmentResponse: Codable {
    let ok: Bool
    let nodeId: String
    let nodeKind: String
    let registrationToken: String
    let active: Bool
    let nodeApproved: Bool
}

struct PasskeyOptionsResponse: Codable {
    let challengeId: String
    let options: PasskeyPublicKeyOptions
}

struct PasskeyPublicKeyOptions: Codable {
    let challenge: String
    let user: PasskeyUser?
    let allowCredentials: [PasskeyCredentialDescriptor]?
    let excludeCredentials: [PasskeyCredentialDescriptor]?

    struct PasskeyUser: Codable {
        let id: String
        let name: String?
        let displayName: String?
    }
}

struct PasskeyCredentialDescriptor: Codable {
    let id: String
    let transports: [String]?
}

struct DiscoveryResponse: Codable {
    struct CoordinatorRecord: Codable, Hashable {
        let peerId: String
        let coordinatorUrl: String
        let source: String
    }

    let generatedAt: Double
    let count: Int
    let coordinators: [CoordinatorRecord]
}

struct AuthCapabilitiesPayload: Codable {
    struct PasskeyPayload: Codable {
        let enabled: Bool
        let rpId: String
        let allowedOrigins: [String]
    }

    struct OAuthPayload: Codable {
        let google: Bool
        let microsoft: Bool
        let apple: Bool
    }

    let password: Bool
    let passkey: PasskeyPayload
    let oauth: OAuthPayload
}
