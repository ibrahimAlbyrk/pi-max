# LSP Tools Extension

Language Server Protocol entegrasyonu ile tanimlama, referans bulma ve derleyici hata/uyarilarini gostermee saglayan extension.

## Kurulum

`.pi/extensions/lsp-tools/` dizini `.pi/extensions/` altinda bulunmalidir. Otomatik yuklenir.

## Tool'lar

### `lsp_diagnostics`

Dosya veya tum calisma alani icin derleyici hata ve uyarilarini dondurur.

| Parametre | Tip | Zorunlu | Aciklama |
|-----------|-----|---------|----------|
| `path` | string | Hayir | Kontrol edilecek dosya. Bos ise tum calisma alani |

```
lsp_diagnostics("src/index.ts")
```

Cikti: dosya yolu, satir, ciddiyet seviyesi ve mesaj.

### `lsp_definition`

Bir sembolun tanimlandigi yere atlar.

| Parametre | Tip | Zorunlu | Aciklama |
|-----------|-----|---------|----------|
| `path` | string | Evet | Sembolun bulundugu dosya |
| `line` | number | Evet | Satir numarasi (1-indexed) |
| `character` | number | Evet | Karakter offset'i (1-indexed) |

```
lsp_definition("src/app.ts", 15, 10)
```

### `lsp_references`

Bir sembolun tum referanslarini calisma alaninda bulur.

| Parametre | Tip | Zorunlu | Aciklama |
|-----------|-----|---------|----------|
| `path` | string | Evet | Sembolun bulundugu dosya |
| `line` | number | Evet | Satir numarasi (1-indexed) |
| `character` | number | Evet | Karakter offset'i (1-indexed) |
| `includeDeclaration` | boolean | Hayir | Tanimlama dahil mi (varsayilan: true) |

```
lsp_references("src/utils.ts", 5, 15)
```

## Komutlar

| Komut | Islem |
|-------|-------|
| `/lsp-setup` | Eksik LSP sunucularini kur |
| `/lsp-status` | Aktif sunuculari goster |

## Desteklenen Diller

TypeScript, JavaScript, Python, Go, Rust, C, C++, Java, PHP, Ruby, Swift, Kotlin, ve daha fazlasi.

Her dil icin uygun LSP sunucusu otomatik tespit edilir ve kurulur.

## Ozellikler

- **Otomatik dil tespiti**: Dosya uzantisina gore dil belirlenir
- **Otomatik kurulum**: Eksik LSP sunucularini tespit eder ve kurar
- **Dosya senkronizasyonu**: Dosya duzenlendiginde LSP sunucusunu bilgilendirir
- **Coklu dil destegi**: Ayni anda birden fazla dil sunucusu calisabilir
- **Durum gosterimi**: Aktif sunucularin durumunu takip eder

## Hook'lar

| Hook | Islem |
|------|-------|
| `tool_result` | Dosya degisikliklerinde LSP sunucusunu bilgilendirir |

## Faydalar

- `grep` yerine semantik sembol arama kullanabilirsiniz (daha dogru sonuclar)
- Derleyici hatalarini kod degisikliginden hemen sonra gorebilirsiniz
- Overload, scope ve namespace cozumlemesi yapar — string eslesmesinden daha guvenilir
- Yorum ve string icindeki eslesleri yok sayar
