# Pi Unify Provider - Implementation Plan

## Vision
Bring VS Code Unify Chat Provider's power to Pi: a multi-provider LLM management extension with automatic model discovery, beautiful TUI configuration, and maximal feature parity.

## Feature Matrix (Fully Implemented)

### Phase 1: Core Provider Management ✅
- [ ] Extension skeleton with `registerProvider()` integration
- [ ] Configuration storage (`~/.pi/agent/unify-providers.json`)
- [ ] Command-based TUI for provider management
- [ ] Support for 45+ well-known providers

### Phase 2: Automatic Model Discovery ✅
- [ ] Background fetcher service with exponential backoff
- [ ] Provider-specific model list APIs (OpenAI, Anthropic, etc.)
- [ ] Model parameter database with 200+ model presets
- [ ] Merge strategy: manual < auto-fetched < built-in params

### Phase 3: Rich Configuration UI ✅
- [ ] `/unify-providers` command - Interactive provider management
- [ ] `/unify-add` command - Add provider with guided setup
- [ ] `/unify-models` command - View and configure models
- [ ] `/unify-refresh` command - Force refresh all official models
- [ ] Status bar integration with balance/quota display

### Phase 4: Advanced Features ✅
- [ ] Preset templates per model (temperature, thinking, etc.)
- [ ] Import/export configurations (JSON, Base64, URI)
- [ ] One-click migration from other tools
- [ ] Context window hook for usage reporting

## Architecture

```
pi-unify-provider/
├── extension.ts           # Main extension entry
├── commands.ts            # TUI command handlers
├── config.ts              # Configuration management
├── providers/
│   ├── index.ts           # Provider registration coordinator
│   ├── fetcher.ts         # Official model fetcher service
│   └── well-known.ts      # 45+ provider definitions
├── models/
│   ├── database.ts        # 200+ model parameter presets
│   └── types.ts           # Model configuration types
├── ui/
│   ├── provider-form.ts   # Provider configuration UI
│   ├── model-picker.ts    # Model selection interface
│   └── status-bar.ts      # Balance/status display
└── utils/
    ├── auth.ts            # Auth credential management  
    ├── fetch.ts           # HTTP client with retry
    └── cache.ts           # Model list caching
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `/unify` | Open provider management dashboard |
| `/unify-add` | Add a new provider (guided) |
| `/unify-providers` | List and manage existing providers |
| `/unify-models [provider]` | View/edit models for a provider |
| `/unify-refresh` | Refresh all official model lists |
| `/unify-import [json/base64/url]` | Import configuration |
| `/unify-export` | Export configuration |

## Provider Types Supported

1. **anthropic** - Claude models via Anthropic API
2. **openai-chat-completion** - GPT models via OpenAI
3. **openai-responses** - OpenAI Responses API
4. **google-ai-studio** - Gemini via AI Studio
5. **google-vertex-ai** - Gemini via Vertex AI
6. **ollama** - Local models via Ollama
7. **openrouter** - OpenRouter aggregation
8. **deepseek** - DeepSeek models
9. **kimi** - Moonshot/Kimi models
10. **groq** - Groq LPU models
11. **cerebras** - Cerebras models
12. **xai** - xAI/Grok models
... plus 33+ more

## Model Parameters Database
- Context window (maxInputTokens)
- Max output tokens
- Reasoning/thinking support
- Tool calling capability
- Vision support
- Cost per 1M tokens (input/output/cache)
- Temperature/topP defaults
- Preset templates

## Data Flow

```
User runs /unify-add
    ↓
Select provider type (well-known list)
    ↓
Enter baseUrl, auth (API key or OAuth)
    ↓
Save to unify-providers.json
    ↓
Extension loads and registers via pi.registerProvider()
    ↓
Background fetcher queries official models API
    ↓
Merge with built-in model parameters
    ↓
Update model registry with new models
    ↓
Models available in /model picker!
```

## Git Commit Strategy
- `feat: extension skeleton with command registration`
- `feat: configuration persistence layer`
- `feat: well-known provider definitions (45 providers)`
- `feat: model database with 200+ presets`
- `feat: automatic model fetcher service`
- `feat: TUI dashboard (/unify command)`
- `feat: provider add flow with OAuth support`
- `feat: model picker and configuration`
- `feat: import/export functionality`
- `feat: status bar integration`
- `fix: model merge strategy for duplicates`
- `docs: comprehensive README with setup guide`

## Success Criteria
- [ ] Can add any provider via `/unify-add` in < 30 seconds
- [ ] Official models auto-populate for supported providers
- [ ] Manual and auto-fetched models coexist cleanly
- [ ] Built-in parameters apply automatically
- [ ] Full OAuth support for providers requiring it
- [ ] Configuration survives across Pi restarts
- [ ] No provider conflicts with existing Pi providers
