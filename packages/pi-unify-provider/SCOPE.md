# Adjusted Scope: 5 Providers + Full Infrastructure

## Target Providers (Non-Built-in)
1. **Poe** (creator.poe.com) - User requested, OAuth + API key
2. **Together AI** (together.xyz) - Popular for open-source models
3. **Fireworks AI** (fireworks.ai) - Fast inference, many models
4. **Perplexity** (perplexity.ai) - pplx-api with Sonar models
5. **AI21 Labs** (ai21.com) - Jurassic models

## What We're Building
- Extension skeleton with provider registration
- Configuration persistence (JSON-based)
- **Automatic model fetching** for all 5 providers
- Model parameter database (context window, costs, capabilities)
- TUI commands: `/unify`, `/unify-add`, `/unify-models`, `/unify-refresh`
- OAuth support for Poe

## Out of Scope (for now)
- Other 40+ providers
- Import/export features
- One-click migration
- Balance monitoring

## Success Criteria
- Can add any of the 5 providers via `/unify-add`
- Official models auto-populate from API
- `/model` picker shows unify-registered models
- OAuth flow works for Poe
