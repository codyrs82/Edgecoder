import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const repoUrl = "https://github.com/your-org/Edgecoder";

export default withMermaid(defineConfig({
  title: "EdgeCoder Docs",
  description: "Wiki-style documentation for the EdgeCoder platform.",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/how-edgecoder-works" },
      { text: "Architecture", link: "/guide/architecture-deep-dive" },
      { text: "Flows", link: "/guide/request-lifecycle-sequences" },
      { text: "Operations", link: "/operations/public-mesh-operations" },
      { text: "Reference", link: "/reference/api-endpoints-detailed" },
      { text: "GitHub", link: repoUrl }
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Welcome", link: "/" },
          { text: "System Overview and Benefits", link: "/guide/system-overview-benefits" },
          { text: "How EdgeCoder Works", link: "/guide/how-edgecoder-works" },
          { text: "Architecture Deep Dive", link: "/guide/architecture-deep-dive" },
          { text: "Request Lifecycle Sequences", link: "/guide/request-lifecycle-sequences" },
          { text: "Model Provider Abstraction", link: "/guide/model-provider-abstraction" },
          { text: "Executor Sandbox and Isolation", link: "/guide/executor-sandbox-isolation" },
          { text: "BLE Local Mesh", link: "/guide/ble-local-mesh" },
          { text: "Model Management", link: "/guide/model-management" }
        ]
      },
      {
        text: "Operations",
        items: [
          { text: "Public Mesh Operations", link: "/operations/public-mesh-operations" },
          { text: "Deployment Topology", link: "/operations/deployment-topology" },
          { text: "Role-based Runbooks", link: "/operations/role-based-runbooks" },
          { text: "Agent Mesh Peer-Direct Flow", link: "/operations/agent-mesh-peer-direct" },
          { text: "Coordinator Discovery and Failover", link: "/operations/coordinator-discovery-failover" },
          { text: "Executor Subset Reference", link: "/operations/executor-subset-reference" },
          { text: "iOS Power Scheduling", link: "/operations/ios-power-scheduling" },
          { text: "Stats Ledger Rollout", link: "/operations/stats-ledger-rollout" },
          { text: "Coordinator Federation", link: "/operations/coordinator-federation" }
        ]
      },
      {
        text: "Security",
        items: [
          { text: "Trust and Security", link: "/security/trust-and-security" },
          { text: "Threat Model", link: "/security/threat-model" },
          { text: "Coordinator Signing Identity", link: "/reference/coordinator-signing-identity" }
        ]
      },
      {
        text: "Economy",
        items: [
          { text: "Credits, Pricing, Issuance", link: "/economy/credits-pricing-issuance" },
          { text: "Settlement Lifecycle", link: "/economy/settlement-lifecycle" },
          { text: "Issuance Parameters", link: "/reference/issuance-economy-params" }
        ]
      },
      {
        text: "Reference",
        items: [
          { text: "API Surfaces", link: "/reference/api-surfaces" },
          { text: "API Endpoints Detailed", link: "/reference/api-endpoints-detailed" },
          { text: "Runtime Modes", link: "/reference/runtime-modes" },
          { text: "Environment Variables", link: "/reference/environment-variables" },
          { text: "Source Markdown Index", link: "/reference/source-markdown-index" }
        ]
      }
    ],
    socialLinks: [{ icon: "github", link: repoUrl }],
    search: {
      provider: "local"
    }
  },
  mermaid: {},
  mermaidPlugin: {
    class: "mermaid-edgecoder"
  }
}));
