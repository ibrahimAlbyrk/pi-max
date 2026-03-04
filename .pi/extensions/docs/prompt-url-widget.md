# Prompt URL Widget Extension

GitHub PR ve issue URL'lerini otomatik tespit ederek metadata getiren ve oturum adini guncelleyen extension.

## Kurulum

`.pi/extensions/prompt-url-widget.ts` konumuna yerlestirin. Otomatik yuklenir.

## Kullanim

Prompt'unuza bir GitHub PR veya issue URL'si yazmak yeterlidir:

```
https://github.com/user/repo/pull/42 inceleyip yorumla
```

Extension URL'yi otomatik tespit eder ve metadata bilgilerini getirir.

## Ozellikler

- **Otomatik URL tespiti**: GitHub PR ve issue URL desenlerini tanir
- **Metadata getirme**: `gh` CLI ile baslik, yazar ve login bilgilerini ceker
- **Oturum yeniden adlandirma**: Oturumu otomatik olarak `PR: <baslik> (<url>)` veya `Issue: <baslik> (<url>)` seklinde adlandirir
- **Widget gorunumu**: Baslik, yazar ve URL bilgilerini cerceveli widget ile gosterir

## Desteklenen URL Desenleri

| Desen | Ornek |
|-------|-------|
| GitHub PR | `https://github.com/owner/repo/pull/123` |
| GitHub Issue | `https://github.com/owner/repo/issues/456` |

## Widget Gorunumu

```
┌─ PR: Fix memory leak in parser ──────┐
│  Author: @username                    │
│  github.com/owner/repo/pull/42        │
└───────────────────────────────────────┘
```

## Hook'lar

| Hook | Islem |
|------|-------|
| `before_agent_start` | Kullanici girdisinde URL deseni arar |
| `session_start` | Widget'i olusturur |
| `session_switch` | Widget'i yeniden olusturur |

## Bagimliliklar

- `gh` CLI (GitHub CLI) kurulu ve authenticate edilmis olmalidir

## Faydalar

- PR/issue ile ilgili calisirken oturumu otomatik adlandirir
- Hangi PR/issue uzerinde calistiginizi gorsel olarak takip edebilirsiniz
- Metadata bilgilerine hizli erisim saglar
