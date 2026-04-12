/**
 * Official Model Fetcher Service
 * Fetches model lists from provider APIs with exponential backoff and caching
 */

import type { UnifyProviderConfig, UnifyModelConfig, ProviderType } from "../config.js";
import type { ConfigStore } from "../config.js";
import { WELL_KNOWN_PROVIDERS, getWellKnownProvider } from "./well-known.js";
import { MODEL_PARAMETERS_DB } from "../models/database.js";

// ============================================================================
// Types
// ============================================================================

export interface FetchResult {
  models: UnifyModelConfig[];
  success: boolean;
  error?: string;
  fetchedAt: number;
}

interface FetchState {
  lastFetchTime: number;
  lastError?: string;
  currentIntervalMs: number;
  consecutiveErrors: number;
}

// ============================================================================
// Provider API Response Types
// ============================================================================

interface TogetherModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  context_length?: number;
  pricing?: {
    input: number;
    output: number;
  };
  capabilities?: {
    vision?: boolean;
    function_calling?: boolean;
  };
}

interface FireworksModel {
  id: string;
  object: "model";
  created?: number;
  owned_by?: string;
  context_length?: number;
}

interface AI21Model {
  id: string;
  name?: string;
  context_length?: number;
  input