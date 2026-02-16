import { PostgresStore } from "./postgres.js";

export const pgStore = PostgresStore.fromEnv();
