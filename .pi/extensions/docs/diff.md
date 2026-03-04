# Diff Extension

Git'te degisen dosyalari interaktif olarak listeleyen ve acan `/diff` komutu.

## Kurulum

`.pi/extensions/diff.ts` konumuna yerlestirin. Otomatik yuklenir.

## Kullanim

pi icerisinde:

```
/diff
```

## Ozellikler

- **Dosya durumu gostergeleri**: Modified (M), Added (A), Deleted (D), Renamed (R), Copied (C)
- **Renk kodlamasi**: Degistirilen dosyalar sari, eklenenler yesil, silinenler kirmizi
- **Interaktif secim**: SelectList ile dosya secimi
- **Dosya acma**: Secilen dosyayi sistem varsayilan uygulamasiyla acar (macOS: `open`)
- **Sayfalama**: Sol/sag ok tuslariyla sayfalar arasi gezinme

## Arayuz

```
┌─ Git Changes ─────────────────────────┐
│  M  src/index.ts                      │
│  A  src/utils/helper.ts               │
│  D  src/old-module.ts                 │
│  R  src/renamed.ts                    │
└───────────────────────────────────────┘
```

## Tuslar

| Tus | Islem |
|-----|-------|
| ↑/↓ | Dosyalar arasi gezinme |
| Enter | Secili dosyayi ac |
| ←/→ | Sayfalama |
| Escape | Kapat |

## Bagimliliklar

- `git` CLI (diff ciktisini okur)
- macOS `open` komutu (dosya acmak icin)

## Faydalar

- pi'dan cikmadan degisen dosyalari gorup acabilirsiniz
- Hangi dosyalarin degistigini hizlica gorebilirsiniz
