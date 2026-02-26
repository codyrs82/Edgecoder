// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

export interface CoordinatorDeploymentPlan {
  coordinatorUiHome: {
    service: "control-plane";
    route: "/ui";
    notes: string;
  };
  firstCoordinatorRuntime: {
    target: "fly_io_app";
    recommendation: string;
    regionHint: string;
    containerized: boolean;
  };
  sqlBackend: {
    engine: "fly_postgres";
    version: string;
    rationale: string;
    connectionEnv: string;
  };
}

export function defaultDeploymentPlan(): CoordinatorDeploymentPlan {
  return {
    coordinatorUiHome: {
      service: "control-plane",
      route: "/ui",
      notes: "Keep first coordinator UI in control-plane to avoid a separate frontend service."
    },
    firstCoordinatorRuntime: {
      target: "fly_io_app",
      recommendation:
        "Run first coordinator on Fly.io as the first public web service with rolling deploys and health checks.",
      regionHint: "Start in primary user region (for example ord or iad) and add Fly regions as mesh grows.",
      containerized: true
    },
    sqlBackend: {
      engine: "fly_postgres",
      version: "16",
      rationale:
        "Fly Postgres (PostgreSQL 16) supports transactional queue state, ledger consistency, and managed failover.",
      connectionEnv: "DATABASE_URL"
    }
  };
}
