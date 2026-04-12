# Pi Unify Provider

A multi-provider LLM management extension for Pi, bringing VS Code Unify Chat Provider's power to the terminal.

## Features

- **5 Popular Providers**: Poe, Together AI, Fireworks AI, Perplexity, AI21 Labs
- **7 Auth Methods**: API Key, OAuth 2.0, OAuth PKCE, Device Code, Browser Session, Custom Headers
- **Automatic Model Fetching**: Fetches official model lists from provider APIs with smart caching
- **Built-in Model Database**: Pre-configured parameters for 20+ popular models
- **Interactive TUI Commands**: Beautiful terminal UI for provider management
- **Keyboard Shortcuts**: Ctrl+Shift+U for quick dashboard access

## Installation

### Option 1: Load as Pi Extension (Development)
```bash
pi -e C:/Users/jery/.pi/agent/extensions/pi-unify-provider
```

### Option 2: Install as Pi Package (Once Published)
```bash
# Future: pi install npm:pi-unify-provider
```

## Quick Start

1. **Load the extension**:
   ```bash
   pi -e C:/Users/jery/.pi/agent/extensions/pi-unify-provider
   ```

2. **Add your first provider** (run inside Pi):
   ```
   /unify-add
   ```
   Or use Ctrl+Shift+U to open the dashboard.

3. **Select a provider type**:
   - 🐦 Poe (OAuth + API Key)
   - 🤝 Together AI (API Key)
   - 🎆 Fireworks AI (API Key)
   - 🔍 Perplexity (API Key)
   - 🧠 AI21 Labs (API Key)

4. **Enter your API key** when prompted (or set environment variable).

5. **Enable auto-fetch** to automatically populate models.

6. **View your models**:
   ```
   /unify-models
   ```

7. **Switch to a Unify model** via Pi's model picker:
   ```
   /model
   ```

## Commands

| Command | Description |
|---------|-------------|
| `/unify` | Open provider dashboard |
| `/unify-add` | Add a new provider (interactive wizard) |
| `/unify-providers` | List and manage configured providers |
| `/unify-models [provider]` | View models for all providers or specific one |
| `/unify-refresh` | Force refresh all official model lists |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+U` | Open Unify dashboard |

## Configuration

Providers are stored in `~/.pi/agent/unify-providers-db.json`:

```json
{
  "version": 1,
  "providers": {
    "Together-AI": {
      "name": "Together-AI",
      "type": "together",
      "baseUrl": "https://api.together.xyz/v1",
      "auth": {
        "type": "api_key",
        "envVar": "TOGETHER_API_KEY",
        "allowStoredKey": true
      },
      "models": [...],
      "autoFetchOfficialModels": true,
      "createdAt": 1234567890,
      "updatedAt": 1234567890
    }
  }
}
```

## Authentication Methods

| Method | Description | Providers |
|--------|-------------|-----------|
| API Key | Standard bearer token auth | Together, Fireworks, Perplexity, AI21 |
| OAuth 2.0 | Browser-based flow with redirect | Poe |
| OAuth PKCE | Secure mobile/CLI flow | (extensible) |
| Device Code | Code entry flow | (extensible) |
| Browser Session | Claude Code-style | (extensible) |
| Custom Headers | Arbitrary header auth | (extensible) |

## Model Database

The extension includes built-in parameters for:

- **Anthropic**: Claude 3 Opus, Sonnet, Haiku
- **OpenAI**: GPT-4o, GPT-4o-mini, o1, o1-mini
- **Google**: Gemini 1.5 Pro, Gemini 1.5 Flash
- **Together**: Llama 3.1 405B/70B, Mistral, DeepSeek, Qwen
- **Fireworks**: Llama 3.1, Mixtral
- **Perplexity**: Sonar, Sonar Pro, Sonar Reasoning
- **AI21**: Jamba 1.5 Large/Mini

Fetched models automatically merge with database parameters.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              Pi Extension Loading                   │
│                     │                                │
│          ┌────────▼─────────┐                      │
│          │   /unify-add      │                      │
│          │   Interactive TUI │                      │
│          └────────┬─────────┘                      │
│                   │                                  │
│      ┌────────────┼────────────┐                   │
│      ▼            ▼            ▼                   │
│  ┌────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Auth   │  │ Provider │  │ Settings │           │
│  │ Config │  │ Type     │  │          │           │
│  └────┬───┘  └────┬─────┘  └────┬─────┘           │
│       │           │            │                    │
│       └─────┬─────┴────────────┘                  │
│             ▼                                       │
│    ┌───────────────────┐                          │
│    │ ConfigStore.save() │                          │
│    │ unify-providers-db │                          │
│    └──────────┬─────────┘                          │
│               │                                      │
│    session_start ──────► pi.registerProvider()   │
│                             │                       │
│                             ▼                       │
│                    ┌───────────────┐               │
│                    │ Model Fetcher │               │
│                    │ (if auto)    │               │
│                    └───────────────┘               │
└─────────────────────────────────────────────────────┘
```

## Development

### Project Structure
```
src/
├── extension.ts          # Main entry point
├── config.ts            # Configuration persistence
├── providers/
│   ├── fetcher.ts       # Official model fetcher service
│   └── well-known.ts    # Provider definitions (5 providers)
├── models/
│   └── database.ts      # Model parameter presets
├── ui/
│   └── commands.ts      # TUI command implementations
└── utils/
    └── auth.ts          # 7 auth method implementations
```

### Testing Locally
```bash
# In Pi console
pi -e C:/Users/jery/.pi/agent/extensions/pi-unify-provider

# Then test:
/unify-add
/unify-providers
/unify-models
/unify-refresh
```

### Adding New Providers

Add to `src/providers/well-known.ts`:

```typescript
myprovider: {
  name: "myprovider",
  type: "myprovider",
  displayName: "My Provider",
  apiType: "openai-completions",
  defaultBaseUrl: "https://api.myprovider.com/v1",
  supportsOfficialModelFetch: true,
  modelsEndpoint: "https://api.myprovider.com/v1/models",
  authType: "api_key",
}
```

Add fetcher in `src/providers/fetcher.ts`:

```typescript
case "myprovider":
  models = await this.fetchMyProviderModels(provider, apiKey);
  break;
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `POE_API_KEY` | Poe API key |
| `TOGETHER_API_KEY` | Together AI API key |
| `FIREWORKS_API_KEY` | Fireworks AI API key |
| `PERPLEXITY_API_KEY` | Perplexity API key |
| `AI21_API_KEY` | AI21 Labs API key |

## Limitations

- OAuth flows require browser access (limited in headless environments)
- Model fetching requires valid API key
- Perplexity doesn't have a model list API (hardcoded)

## Roadmap

- [ ] 40+ additional providers
- [ ] Import/Export configurations
- [ ] One-click migration from other tools
- [ ] Balance/quota monitoring
- [ ] Preset templates UI
- [ ] Custom model parameters UI

## License

MIT
