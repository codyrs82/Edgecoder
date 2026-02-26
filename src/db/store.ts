// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { PostgresStore } from "./postgres.js";

export const pgStore = PostgresStore.fromEnv();
