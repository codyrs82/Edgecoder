// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/** Agents held by an unpaid direct-payment quote (set by direct-payments.ts when that path is on). */
export const directQuoteHolds: { agentIds: () => ReadonlySet<string> } = { agentIds: () => new Set<string>() };
