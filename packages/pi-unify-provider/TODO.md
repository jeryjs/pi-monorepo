# Pi Unify Provider - Implementation Checklist

## Phase 1: Core Infrastructure ✅
- [x] Extension skeleton with command registration
- [x] Configuration persistence layer (ConfigStore)
- [x] Type definitions for providers, models, auth
- [x] Well-known provider definitions (5 providers)
- [x] Model fetcher service structure

## Phase 2: Authentication System ✅
- [x] 7 auth method type definitions:
  - [x] api_key
  - [x] bearer_token
  - [x] oauth2
  - [x] oauth2_pkce
  - [x] oauth_device_code
  - [x] browser_session
  - [x] custom_header
  - [x] query_param
  - [x] none
- [x] AuthManager implementation
- [x] OAuth flow handlers (initiate, complete, refresh)
- [x] API key storage (env + secret storage)

## Phase 3: Model Management ✅ COMPLETE
- [x] Complete model fetcher implementations:
  - [x] Together AI fetcher
  - [x] Fireworks AI fetcher
  - [x] AI21 fetcher
  - [x] Poe fetcher
  - [x] Perplexity hardcoded models
- [x] Model parameters database (20+ presets, extensible)
- [x] Model merge strategy (fetched + built-in + manual)
- [x] Exponential backoff implementation
- [x] Caching system
- [x] Error handling & retry logic

## Phase 4: TUI Commands ✅ COMPLETE
- [x] Command registration structure
- [x] showProviderDashboard() - Main dashboard
- [x] showAddProviderFlow() - Interactive wizard
- [x] showModelsList() - Model browser
- [x] showProviderDetails() - Provider options
- [x] refreshAllProviders() - Force refresh

## Phase 5: Integration & Testing 🔄 IN PROGRESS
- [x] Complete extension.ts integration
- [x] Provider registration on session_start
- [x] Event hooks (before_provider_request)
- [x] Keyboard shortcuts (Ctrl+Shift+U)
- [x] Real-time model updates
- [x] Error boundaries
- [ ] Manual testing with each provider
- [ ] Install and test in Pi
- [ ] Fix any runtime errors

## Phase 6: Polish & Documentation ⏳ LATER
- [ ] README with setup instructions
- [ ] Error messages & user guidance
- [ ] Validation (URL, auth, etc.)
- [ ] Import/export functionality
- [ ] Balance monitoring hooks
- [ ] Preset templates UI

## Current Blockers
1. Model fetcher implementations incomplete
2. Model database needs populated
3. TUI commands need completion
4. Need integration testing

## Testing Checklist
- [ ] /unify command opens dashboard
- [ ] /unify-add wizard completes successfully
- [ ] Provider registration works
- [ ] Model fetching works for Together AI
- [ ] OAuth flow works for Poe
- [ ] Models appear in /model picker
- [ ] API requests use correct auth headers
- [ ] Auto-refresh triggers on schedule
- [ ] Error handling shows user-friendly messages
