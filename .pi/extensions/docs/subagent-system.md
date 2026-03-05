# Subagent System Extension

Asenkron alt-agent'lar olusturma, yonetme ve koordine etme yetenegi saglayan extension.

## Kurulum

`.pi/extensions/subagent-system/` dizini `.pi/extensions/` altinda bulunmalidir. Otomatik yuklenir.

## Kullanim

### Tool (Agent tarafindan)

```
spawn_agent(agent="explorer", task="src/ altindaki tum TypeScript dosyalarini incele")
spawn_agent(agent="worker", task="Login formunu implement et", taskIds=[5, 6])
spawn_agent(name="custom", systemPrompt="Sen bir test uzmansin", task="Unit test yaz")
```

### Komutlar

| Komut | Islem |
|-------|-------|
| `/agents` | Calisan agent'lari listele |

### Kisayol

| Tus | Islem |
|-----|-------|
| `Ctrl+Shift+A` | Agent dashboard'u ac |

## Onceden Tanimli Agent'lar

| Agent | Amac | Araclar |
|-------|------|---------|
| `explorer` | Arastirma: arama, okuma, analiz, kod kesfetme | read, search, bash |
| `worker` | Kod yazma/duzenleme | read, write, edit, bash |
| `planner` | Mimari kararlar, tasarim | read, search |
| `reviewer` | Kod inceleme: bug, guvenlik, kalite | read, search, bash |

## Tool Parametreleri

### `spawn_agent`

| Parametre | Tip | Zorunlu | Aciklama |
|-----------|-----|---------|----------|
| `agent` | string | * | Onceden tanimli agent adi |
| `name` | string | * | Ozel agent adi (runtime modu) |
| `systemPrompt` | string | ** | Sistem prompt'u (runtime modu) |
| `task` | string | Evet | Gorev aciklamasi |
| `tools` | string[] | Hayir | Kullanilabilir araclar |
| `model` | string | Hayir | Kullanilacak model |
| `thinking` | string | Hayir | Thinking seviyesi (off/minimal/low/medium/high/xhigh) |
| `taskIds` | number[] | Hayir | Iliskilendirilecek task ID'leri |

\* `agent` veya `name` + `systemPrompt` kullanilmalidir.
\*\* Sadece runtime modunda zorunlu.

### `stop_agent`

| Parametre | Tip | Zorunlu | Aciklama |
|-----------|-----|---------|----------|
| `agent` | string | Evet | Agent ID veya adi |

### `list_agents`

Parametre gerektirmez. Mevcut agent tiplerini listeler.

## Iki Kullanim Modu

### 1. Onceden Tanimli (Predefined)

```
spawn_agent(agent="explorer", task="...")
```

Agent yapilandirmasi otomatik yuklenir. Sistem prompt'u, araclar ve diger ayarlar dahili olarak belirlenir.

### 2. Calisma Zamani (Runtime)

```
spawn_agent(name="security-auditor", systemPrompt="...", task="...", tools=["read", "search"])
```

Tamamen ozel agent tanimi. Sistem prompt'u ve araclar el ile belirtilir.

## Task Entegrasyonu

`taskIds` parametresi kullanildiginda, belirtilen task'larin detaylari agent'in sistem prompt'una otomatik enjekte edilir:

```
spawn_agent(agent="worker", task="Implement et", taskIds=[5])
```

Agent, task #5'in basligini, aciklamasini ve bagimliliklarini sistem prompt'unda gorur.

## Hook Motoru

Extension, agent'lar icerisinde ozel aksiyonlar kaydetmek icin bir hook motoru sunar:

```
ctx.events.emit("subagent:register-action", { name: "custom-action", handler: ... })
```

## Faydalar

- Arastirma ve analiz islerini paralel agent'lara devredebilirsiniz
- Her agent kendi bağlamında calisir, ana oturumu etkilemez
- Task sistemi ile entegre calisarak gorev takibi yapabilirsiniz
- Onceden tanimli agent'lar sayesinde hizli baslangic
- Ozel agent'lar ile ozellestirilmis is akislari olusturabilirsiniz
