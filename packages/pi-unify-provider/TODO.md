# Pi Unify Provider - Implementation Checklist

## Phase 1: Core Infrastructure ✅
- [ ] Extension skeleton with command registration
- [ ] Configuration persistence layer (ConfigStore)
- [ ] Type definitions for providers, models, auth
- [ ] Well-known provider definitions (5 providers)
- [ ] Model fetcher service structure

## Phase 2: Authentication System ✅
- [ ] 7 auth method type definitions:
  - [ ] api_key
  - [ ] bearer_token
  - [ ] oauth2
  - [ ] oauth2_pkce
  - [ ] oauth_device_code
  - [ ] browser_session
  - [ ] custom_header
  - [ ] query_param
  - [ ] none
- [ ] AuthManager implementation
- [ ] OAuth flow handlers (initiate, complete, refresh)
- [ ] API key storage (env + secret storage)

## Phase 3: Model Management ✅ COMPLETE
- [ ] Complete model fetcher implementations:
  - [ ] Together AI fetcher
  - [ ] Fireworks AI fetcher
  - [ ] AI21 fetcher
  - [ ] Poe fetcher
  - [ ] Perplexity hardcoded models
- [ ] Model parameters database (20+ presets, extensible)
- [ ] Model merge strategy (fetched + built-in + manual)
- [ ] Exponential backoff implementation
- [ ] Caching system
- [ ] Error handling & retry logic

## Phase 4: TUI Commands ✅ COMPLETE
- [ ] Command registration structure
- [ ] showProviderDashboard() - Main dashboard
- [ ] showAddProviderFlow() - Interactive wizard
- [ ] showModelsList() - Model browser
- [ ] showProviderDetails() - Provider options
- [ ] refreshAllProviders() - Force refresh

## Phase 5: Integration & Testing 🔄 IN PROGRESS
- [ ] Complete extension.ts integration
- [ ] Provider registration on session_start
- [ ] Event hooks (before_provider_request)
- [ ] Keyboard shortcuts (Ctrl+Shift+U)
- [ ] Real-time model updates
- [ ] Error boundaries
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
