# Pi Unify Provider - Development Context

## Overview
Building a VS Code Unify Chat Provider equivalent for Pi. This extension allows managing multiple LLM providers with automatic model discovery.

## Key Architecture Patterns
1. **Extension Entry Point**: `src/extension.ts` exports default function receiving `ExtensionAPI`
2. **Provider Registration**: Use `pi.registerProvider()` to dynamically add models
3. **Configuration Store**: JSON file at `~/.pi/agent/unify-providers-db.json`
4. **Model Fetcher**: Background service with exponential backoff for API calls
5. **TUI Commands**: Use `pi.registerCommand()` for interactive configuration

## Import Patterns
```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
```

## File Organization
- `src/extension.ts` - Main entry, command registration
- `src/config.ts` - Persistence layer for provider configs
- `src/providers/` - Provider definitions and fetcher logic
- `src/models/` - Model parameter database
- `src/ui/` - TUI components for configuration
- `src/utils/` - Shared utilities

## Critical APIs
- `pi.registerProvider(name, config)` - Register a provider dynamically
- `pi.registerCommand(name, handler)` - Add slash commands
- `pi.on(event, handler)` - Subscribe to lifecycle events
- `ctx.ui.notify(msg, level)` - Show notifications
- `ctx.ui.input(options)` - Prompt for input
- `ctx.ui.quickPick(options)` - Selection UI

## Extension Event Hooks
- `session_start` - Initialize and register stored providers
- `model_select` - Track model changes
- `before_provider_request` - Inject custom headers/parameters

## Testing Approach
Install locally with: `pi -e C:/Users/jery/.pi/agent/extensions/pi-unify-provider`
