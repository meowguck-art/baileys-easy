# baileys-easy

The **"easy"** extras from the [itsliaaa/baileys](https://github.com/itsliaaa/baileys)
fork, re-implemented as a side helper on top of official
[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) —
**without patching Baileys' source**.

Everything goes through official exports (`generateWAMessageContent`,
`generateWAMessageFromContent`, `generateWAMessage`, `prepareWAMessageMedia`,
`proto`, `sock.relayMessage`), so it keeps working across Baileys upgrades.

## Files

| File | For |
|---|---|
| `baileys-easy.mjs` | ES modules (`import`) — the single implementation |
| `baileys-easy.cjs` | CommonJS (`require`) — thin wrapper (needs Node ≥ 22.12) |
| `store/` | Standalone `makeInMemoryStore` (+ 2 small utils), adapted to official Baileys |
| `test.mjs` | 48 smoke tests, no WhatsApp connection needed |
| `package.json` | Metadata; `@whiskeysockets/baileys` is a **peer** dependency |

## Quick start

```js
import { sendEasyMessage } from 'baileys-easy'

// simplified externalAdReply — no contextInfo boilerplate
await sendEasyMessage(sock, jid, {
  text: 'Check this out',
  externalAdReply: {
    title: 'My site',
    body: 'click me',
    url: 'https://example.com',
    thumbnail: thumbnailBuffer // Buffer
  }
})

// mention everyone
await sendEasyMessage(sock, groupJid, { text: 'hello all', mentionAll: true })

// Meta AI badge (1:1 chats only)
await sendEasyMessage(sock, userJid, { text: 'I am AI ✨', ai: true })

// view-once / ephemeral / lottie wrappers
await sendEasyMessage(sock, jid, { image: { url: '...' }, viewOnce: true })
await sendEasyMessage(sock, jid, { text: 'burn after reading', ephemeral: true })

// photo album (min. 2 items)
await sendEasyMessage(sock, jid, {
  album: [{ image: buf1, caption: 'one' }, { image: buf2, caption: 'two' }]
})

// quote a message inside a channel (official Baileys skips `quoted` for newsletters)
await sendEasyMessage(sock, newsletterJid, { text: 'reply' }, { quoted: someMsg })

// raw proto passthrough
await sendEasyMessage(sock, jid, { raw: { conversation: 'hi' } })
```

## Content flags

All flags live **inside** the content object, next to the usual
`{ text / image / video / audio / document / sticker / poll }`:

| Flag | What it does |
|---|---|
| `externalAdReply: {title, body, url, thumbnail, largeThumbnail, mediaType}` | link preview card, expanded with sane defaults |
| `mentionAll: true` | `contextInfo.nonJidMentions = 1` (also accepts `mentions: [...]`) |
| `groupStatus: true` | `isGroupStatus` + `groupStatusMessageV2` wrapper |
| `interactiveAsTemplate: true` | wraps `interactiveMessage` in `templateMessage` |
| `ephemeral: true` | `ephemeralMessage` wrapper |
| `isLottie: true` | `lottieStickerMessage` wrapper |
| `viewOnce` / `viewOnceV2` / `viewOnceV2Extension` | respective wrappers |
| `ai: true` | AI badge (`supportPayload` + `bot` node). 1:1 chats only |
| `raw: {...}` | pre-built proto message, sent as-is |
| `paymentInviteServiceType` | `paymentInviteMessage` |
| `orderText` + `thumbnail` (Buffer) | `orderMessage` with defaults |
| `requestPaymentFrom` | `requestPaymentMessage` wrapping a text/sticker note |
| `invoiceNote` | `invoiceMessage` wrapping an image/document |
| `product: {businessOwnerJid, image, product: {...}}` | `productMessage` with defaults |
| `keep: key` / `pin: key` | `keepInChatMessage` / `pinInChatMessage` |
| `requestPhoneNumber` / `sharePhoneNumber` / `limitSharing` | protocol messages |
| `buttonReply: {id, displayText[, index]}` + `type: 'plain'/'template'` | buttons/template response |
| `listReply: {id, title, description}` | list response |
| `flowReply: {text, name, paramsJson, version, format}` | native-flow response |
| `album: [...]` | album parent + media items linked via `messageAssociation` |
| `buttons` / `sections` / `templateButtons` / `nativeFlow` / `cards` | interactive messages (quick_reply/cta buttons, lists, hydrated templates, native flows, carousels) — with biz node + bot node on send |

`sendEasyMessage(sock, jid, content, options)` — options: `quoted`, `userJid`,
`messageId`, `timestamp`, `upload` (default: `sock.waUploadToServer`),
`mediaCache`, `getUrlInfo`, `additionalNodes`, `relayOptions`, `albumDelayMs`
(default 1500), `mentions`, `ephemeralExpiration`.

## Other exports

```js
import { findUserId, makeInMemoryStore, easySocketDefaults } from 'baileys-easy'

// PN <-> LID via the socket's signal repository
const { lid, phoneNumber } = await findUserId(sock, '9725...@s.whatsapp.net')

// in-memory store (chats/messages/contacts/...), no Baileys patch needed
const store = makeInMemoryStore({})
store.bind(sock.ev)

// the fork's makeWASocket defaults, as a spreadable object
const sock = makeWASocket({ ...easySocketDefaults, auth, logger })
```

## Deliberately NOT included

These need proto regeneration or deep Baileys internals, so they can't be
clean helper features: `spoiler`, sticker packs, native flows / carousels,
rich responses, newsletter media upload paths, incoming edit decryption.

## Test

```sh
node test.mjs   # 48 checks, no connection needed (needs @whiskeysockets/baileys resolvable)
```
