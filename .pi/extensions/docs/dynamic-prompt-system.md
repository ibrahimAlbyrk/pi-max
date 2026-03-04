# Dynamic Prompt System (DPS) Extension

Calisma zamaninda kosullara bagli olarak sistem prompt'unu dinamik olarak olusturan moduler prompt enjeksiyon sistemi.

## Kurulum

`.pi/extensions/dynamic-prompt-system/` dizini `.pi/extensions/` altinda bulunmalidir. Otomatik yuklenir.

## Ozellikler

- **Segment kayit sistemi**: YAML frontmatter + icerik formatinda prompt parcalari
- **4 katmanli yapi**: L0-L3 sistem prompt, L4 context mesajlari
- **Kosul motoru**: Calisma zamani durumuna gore segment aktif/pasif
- **Otomatik yol cozumleme**: Extension, global ve proje dizinlerini tarar
- **Durum takibi**: Tool kullanimi, tur sayaci, model yetenekleri

## Katmanlar

| Katman | Isim | Aciklama |
|--------|------|----------|
| L0 | Core | Temel sistem prompt'u |
| L1 | Environment | Ortam bilgisi (OS, dizin, tarih) |
| L2 | Tool | Kullanilan araclara ozel talimatlar |
| L3 | Custom | Kullanici tanimli segmentler |
| L4 | Reminder | Context mesajlarina enjekte edilen hatirlatmalar |

L0-L3 segmentleri birlestirilip sistem prompt'una eklenir. L4 segmentleri ayri mesajlar olarak context'e eklenir.

## Segment Formati

```yaml
---
name: git-safety
layer: L2
conditions:
  toolsUsed:
    - bash
  minTurns: 3
priority: 10
---
Git islemleri sirasinda dikkatli olun. Her zaman `git status` ile durumu kontrol edin.
```

### Frontmatter Alanlari

| Alan | Tip | Aciklama |
|------|-----|----------|
| `name` | string | Segment adi |
| `layer` | L0-L4 | Katman |
| `conditions` | object | Aktivasyon kosullari |
| `priority` | number | Siralama onceligi |

### Kosullar

| Kosul | Tip | Aciklama |
|-------|-----|----------|
| `toolsUsed` | string[] | Bu araclar kullanildiysa aktif |
| `minTurns` | number | Minimum tur sayisi |
| `modelCapabilities` | string[] | Model yetenekleri |

## Segment Dizinleri

Segmentler su dizinlerden yuklenir (oncelik sirasina gore):

1. Extension icerisindeki `segments/` dizini
2. `~/.pi/agent/prompts/dps/` (global)
3. `.pi/prompts/dps/` (proje)

## Hook'lar

| Hook | Islem |
|------|-------|
| `session_start` | Segment'leri yukler, durumu baslatir |
| `before_agent_start` | Sistem prompt'unu olusturur |
| `context` | L4 hatirlatmalarini ekler |
| `tool_call` | Tool kullanimini izler |
| `turn_end` | Tur sayacini arttirir |
| `model_select` | Model bilgisini gunceller |

## Debug

```
/dps-log
```

Aktif segmentleri, kosul degerlerini ve birlestirilen prompt'u gosterir.

## Faydalar

- Sistem prompt'u agent'in durumuna gore otomatik adapte olur
- Gereksiz talimatlarin prompt'a eklenmesini onler (token tasarrufu)
- Proje bazinda ozel prompt parcalari tanimlayabilirsiniz
- Moduler yapi sayesinde segment ekleme/cikarma kolay
