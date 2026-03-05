# Prompt Package (packages/prompt)

Merkezi prompt yonetim sistemi: sablon render'lama, kalitim, kompozisyon ve cache destegi.

## Genel Bakis

`packages/prompt` paketi, pi ekosistemin tamaminda kullanilan prompt sablonlarini yoneten temel altyapi paketidir. Sistem prompt'lari, tool aciklamalari ve agent yapilandirmalari bu paket uzerinden yonetilir.

## Temel Kavramlar

### Sablon Dosyalari

`.prompt.md` uzantili dosyalar, YAML frontmatter + sablon govdesinden olusur:

```markdown
---
name: my-prompt
description: Ornek prompt
version: 1
variables:
  - name: PROJECT_NAME
    type: string
    required: true
  - name: FEATURES
    type: string[]
    default: []
---
{{PROJECT_NAME}} projesi icin talimatlar.

{{#if FEATURES}}
Ozellikler:
{{#each FEATURES as feature}}
- {{feature}}
{{/each}}
{{/if}}
```

### Frontmatter Alanlari

| Alan | Tip | Aciklama |
|------|-----|----------|
| `name` | string | Sablon adi (benzersiz) |
| `description` | string | Aciklama |
| `version` | number | Surum numarasi |
| `variables` | array | Degisken tanimlari |
| `extends` | string | Kalitim yapilacak ust sablon |
| `includes` | string[] | Dahil edilecek parcalar |

### Degisken Tipleri

| Tip | Ornek |
|-----|-------|
| `string` | `"hello"` |
| `number` | `42` |
| `boolean` | `true` |
| `string[]` | `["a", "b"]` |
| `object[]` | `[{name: "x"}]` |

## Sablon Sozdizimi

| Sozdizimi | Islem | Ornek |
|-----------|-------|-------|
| `{{VAR}}` | Degisken | `{{PROJECT_NAME}}` |
| `{{item.prop}}` | Ozellik erisimi | `{{tool.name}}` |
| `{{#if COND}}...{{/if}}` | Kosullu | `{{#if DEBUG}}...{{/if}}` |
| `{{#unless VAR}}...{{/unless}}` | Ters kosullu | `{{#unless QUIET}}...{{/unless}}` |
| `{{#each ARR as item}}...{{/each}}` | Dongu | `{{#each TOOLS as t}}{{t}}{{/each}}` |
| `{{> name}}` | Partial dahil etme | `{{> header}}` |

## API

```typescript
import { createPromptRegistry } from "@anthropic/prompt"

const registry = createPromptRegistry({
  directories: ["./prompts"],
  additionalDirectories: ["./custom-prompts"]
})

// Render
const result = registry.render("my-prompt", {
  PROJECT_NAME: "pi",
  FEATURES: ["arama", "duzenleme"]
})

// Meta bilgisi
const meta = registry.getMeta("my-prompt")

// Listeleme
const all = registry.list()
const tools = registry.listByCategory("tools")

// Cache gecersizlestirme
registry.invalidate("my-prompt")  // tek sablon
registry.invalidate()              // tumunu
```

### PromptRegistry Arayuzu

| Metod | Aciklama |
|-------|----------|
| `render(name, variables?)` | Sablonu render et |
| `getMeta(name)` | Meta bilgisini getir |
| `list()` | Tum sablonlari listele |
| `listByCategory(category)` | Kategoriye gore listele |
| `invalidate(name?)` | Cache'i gecersizlestir |
| `validate()` | Tum sablonlari dogrula |

## Kalitim (Extends)

Tek kalitim destegi. Ust sablonun govdesi alt sablonun basina eklenir:

```yaml
---
name: child-prompt
extends: parent-prompt
---
Alt sablona ozel icerik.
```

Maksimum derinlik: 5 seviye.

## Kompozisyon (Includes)

Birden fazla parcayi dahil etme:

```yaml
---
name: full-prompt
includes:
  - header
  - rules
  - footer
---
Ana icerik.
```

## Sablon Kategorileri

| Dizin | Icerik |
|-------|--------|
| `system/` | Ana sistem prompt'lari (coding-agent, mom, pods, web-ui) |
| `tools/` | Tool aciklamalari (read, write, edit, bash, search, lsp_*) |
| `agents/` | Agent sistem prompt'lari (explorer, worker, planner, reviewer) |
| `compaction/` | Context yonetimi (summarize, branch-summary, turn-prefix) |

Tool sablonlarinin tam ve kisa versiyonlari bulunur:
- `read.prompt.md` — tam versiyon
- `read-short.prompt.md` — kisa versiyon

## Hata Siniflari

| Sinif | Durum |
|-------|-------|
| `PromptNotFoundError` | Sablon bulunamadi |
| `VariableRequiredError` | Zorunlu degisken eksik |
| `CircularReferenceError` | Dongusel kalitim |
| `TemplateRenderError` | Render hatasi |
| `PromptParseError` | Ayristirma hatasi |
| `ExtendsDepthError` | Kalitim derinlik asimi |

## Cache

- Ayristirilmis sablonlar bellekte cache'lenir
- Cozumlenmis (resolved) sablonlar ayri cache'lenir
- `invalidate()` ile manuel gecersizlestirme yapilabilir

## Faydalar

- Prompt'lari tek merkezden yonetebilirsiniz
- Kalitim ve kompozisyon ile tekrari onlersiniz
- Degisken sistemi ile dinamik prompt olusturabilirsiniz
- Dogrulama ile hatalari erken yakalayabilirsiniz
- Cache sayesinde tekrar render'da performans kazanirsiniz
- Tum pi bilesenlerinde tutarli prompt yonetimi saglar
