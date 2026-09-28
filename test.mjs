// Smoke tests for baileys-easy — no WhatsApp connection needed.
// Run from ~/workspace/wa-buttons-demo so @whiskeysockets/baileys resolves:
//   node /home/hatch/workspace/helpers/baileys-easy/test.mjs
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(__dirname, 'baileys-easy.mjs'))

const easy = await import(join(__dirname, 'baileys-easy.mjs'))
const baileys = await import('@whiskeysockets/baileys')
const { proto, normalizeMessageContent, getContentType } = baileys

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
	if (cond) { pass++; console.log('  ✅', name) }
	else { fail++; console.log('  ❌', name, extra) }
}

// ---- mock socket -----------------------------------------------------------
const sent = []
const fakeUpload = async () => ({
	mediaKey: Buffer.alloc(32, 1),
	directPath: '/fake/path',
	fileSha256: Buffer.alloc(32, 2),
	fileEncSha256: Buffer.alloc(32, 3),
	fileLength: 100,
	url: 'https://fake.local/f'
})
const mockSock = {
	user: { id: '1234567890@s.whatsapp.net' },
	waUploadToServer: fakeUpload,
	relayMessage: async (jid, message, opts) => {
		sent.push({ jid, message, opts })
		return { key: { id: opts.messageId } }
	},
	signalRepository: {
		lidMapping: {
			getLIDsForPNs: async ([pn]) => pn === '1234567890@s.whatsapp.net' ? [{ lid: '111222333@lid' }] : [],
			getPNsForLIDs: async ([lid]) => lid === '111222333@lid' ? [{ pn: '1234567890@s.whatsapp.net' }] : []
		}
	}
}
const last = () => sent[sent.length - 1]
const reset = () => { sent.length = 0 }

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

console.log('— ESM import')
ok('module loads', typeof easy.sendEasyMessage === 'function')

console.log('— CJS require')
const cjs = require('./baileys-easy.cjs')
ok('cjs loads + same fn', typeof cjs.sendEasyMessage === 'function')

console.log('— text + externalAdReply')
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', {
	text: 'hello',
	externalAdReply: { title: 'T', body: 'B', url: 'https://example.com', thumbnail: PNG }
})
{
	const m = last().message
	const ear = m.extendedTextMessage.contextInfo.externalAdReply
	ok('title kept', ear.title === 'T')
	ok('mediaType default 1', ear.mediaType === 1)
	ok('sourceUrl set', ear.sourceUrl === 'https://example.com')
	ok('thumbnail buffer kept', Buffer.isBuffer(ear.thumbnail))
	// proto round-trip: nothing dropped
	const enc = proto.Message.encode(m).finish()
	const dec = proto.Message.decode(enc)
	ok('proto round-trip keeps adReply', dec.extendedTextMessage.contextInfo.externalAdReply.title === 'T')
}

console.log('— mentionAll')
reset()
await easy.sendEasyMessage(mockSock, '120363000000@g.us', { text: 'hi all', mentionAll: true })
{
	const m = last().message
	ok('nonJidMentions=1', normalizeMessageContent(m).extendedTextMessage.contextInfo.nonJidMentions === 1)
}

console.log('— viewOnce / ephemeral / isLottie wrappers')
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { text: 'secret', viewOnce: true })
ok('viewOnceMessage wrapper', !!last().message.viewOnceMessage)
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { text: 'x', ephemeral: true })
ok('ephemeralMessage wrapper', !!last().message.ephemeralMessage)
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { text: 'x', viewOnceV2: true })
ok('viewOnceMessageV2 wrapper', !!last().message.viewOnceMessageV2)
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { text: 'x', viewOnceV2Extension: true })
ok('viewOnceMessageV2Extension wrapper', !!last().message.viewOnceMessageV2Extension)

console.log('— ai flag')
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { text: 'ai says hi', ai: true })
{
	const s = last()
	ok('bot node in additionalNodes', s.opts.additionalNodes.some(n => n.tag === 'bot' && n.attrs.biz_bot === '1'))
	ok('supportPayload set', s.message.messageContextInfo.supportPayload.includes('is_ai_message'))
}
{
	let threw = false
	try { await easy.sendEasyMessage(mockSock, '120363000000@g.us', { text: 'x', ai: true }) }
	catch { threw = true }
	ok('ai throws in group', threw)
}

console.log('— groupStatus')
reset()
await easy.sendEasyMessage(mockSock, 'status@broadcast', { text: 'gs', groupStatus: true })
{
	const m = last().message
	ok('groupStatusMessageV2 wrapper', !!m.groupStatusMessageV2)
	const inner = normalizeMessageContent(m)
	ok('isGroupStatus set', getContentType(inner) === 'extendedTextMessage' && inner.extendedTextMessage.contextInfo.isGroupStatus === true)
}

console.log('— payments / pin / keep / replies')
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { paymentInviteServiceType: 1 })
ok('paymentInviteMessage', !!last().message.paymentInviteMessage)
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { keep: { remoteJid: 'x', id: 'y', fromMe: true }, type: 2 })
ok('keepInChatMessage', !!last().message.keepInChatMessage)
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { pin: { remoteJid: 'x', id: 'y' }, type: 1, time: 60 })
{
	const m = last().message
	ok('pinInChatMessage', !!m.pinInChatMessage)
	ok('addOn duration', m.messageContextInfo.messageAddOnDurationInSecs === 60)
}
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { listReply: { id: 'r1', title: 'Row', description: 'desc' } })
ok('listResponseMessage', !!last().message.listResponseMessage)
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { buttonReply: { id: 'b1', displayText: 'Tap' }, type: 'plain' })
ok('buttonsResponseMessage', !!last().message.buttonsResponseMessage)
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { buttonReply: { id: 'b1', displayText: 'Tap', index: 0 }, type: 'template' })
ok('templateButtonReplyMessage', !!last().message.templateButtonReplyMessage)
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { flowReply: { text: 'done', name: 'flow_x' } })
ok('interactiveResponseMessage', !!last().message.interactiveResponseMessage)
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { sharePhoneNumber: true })
ok('sharePhoneNumber protocol', last().message.protocolMessage.type === proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER)
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { requestPhoneNumber: true })
ok('requestPhoneNumberMessage', !!last().message.requestPhoneNumberMessage)
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { limitSharing: true })
{
	const pm = last().message.protocolMessage
	ok('limitSharing protocol', pm.type === proto.Message.ProtocolMessage.Type.LIMIT_SHARING && pm.limitSharing.sharingLimited === true)
}

console.log('— raw passthrough')
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { raw: { conversation: 'raw text' } })
ok('raw conversation', last().message.conversation === 'raw text')

console.log('— interactiveAsTemplate')
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', {
	raw: { interactiveMessage: { body: { text: 'body' }, footer: { text: 'f' }, header: { title: 'h', hasMediaAttachment: false }, nativeFlowMessage: { buttons: [] } } },
	interactiveAsTemplate: true
})
{
	const m = last().message
	ok('templateMessage wrapper', !!m.templateMessage?.interactiveMessageTemplate)
	ok('templateId present', typeof m.templateMessage.templateId === 'string')
}

console.log('— newsletter manual quoting')
reset()
const fakeQuoted = {
	key: { remoteJid: '1234567890@newsletter', id: 'Q1', fromMe: false, participant: '999@s.whatsapp.net' },
	message: { conversation: 'quoted text' }
}
await easy.sendEasyMessage(mockSock, '1234567890@newsletter', { text: 'reply in channel' }, { quoted: fakeQuoted })
{
	const m = last().message
	const ci = m.extendedTextMessage.contextInfo
	ok('quotedMessage present in newsletter', !!ci.quotedMessage)
	ok('stanzaId set', ci.stanzaId === 'Q1')
	ok('participant normalized', ci.participant === '999@s.whatsapp.net')
}

console.log('— album')
{
	let threw = false
	try { await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', { album: [{ image: PNG }] }) }
	catch { threw = true }
	ok('album <2 items throws', threw)
}
reset()
try {
	await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', {
		album: [{ image: PNG, caption: 'one' }, { image: PNG, caption: 'two' }],
	}, { albumDelayMs: 10 })
	const parent = sent[0].message
	ok('album parent sent', !!parent.albumMessage)
	ok('expectedImageCount=2', parent.albumMessage.expectedImageCount === 2)
	ok('2 media items relayed', sent.length === 3)
	const itemCtx = sent[1].message.messageContextInfo
	ok('messageAssociation MEDIA_ALBUM', itemCtx.messageAssociation?.associationType === proto.MessageAssociation.AssociationType.MEDIA_ALBUM)
	ok('parent key linked', itemCtx.messageAssociation.parentMessageKey.id === sent[0].opts.messageId)
} catch (e) {
	ok('album happy path (media upload may need thumbnail libs)', false, e.message.split('\n')[0])
}

console.log('— product')
reset()
try {
	await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', {
		product: { businessOwnerJid: '1234567890@s.whatsapp.net', image: PNG, product: { title: 'T', priceAmount1000: 5000, currencyCode: 'USD' } }
	})
	const pm = last().message.productMessage
	ok('productMessage built', !!pm?.product?.productImage)
	ok('defaults merged', pm.product.inStockQuantity === 0 && pm.product.title === 'T')
} catch (e) {
	ok('product happy path (media upload may need thumbnail libs)', false, e.message.split('\n')[0])
}

console.log('— findUserId')
{
	const r1 = await easy.findUserId(mockSock, '1234567890@s.whatsapp.net')
	ok('PN -> LID', r1.lid === '111222333@lid' && r1.phoneNumber === '1234567890@s.whatsapp.net')
	const r2 = await easy.findUserId(mockSock, '111222333@lid')
	ok('LID -> PN', r2.phoneNumber === '1234567890@s.whatsapp.net' && r2.lid === '111222333@lid')
}

console.log('— makeInMemoryStore')
{
	const { makeInMemoryStore } = easy
	ok('exported', typeof makeInMemoryStore === 'function')
	const { EventEmitter } = await import('events')
	const ev = new EventEmitter()
	ev.buffer = () => {}
	const store = makeInMemoryStore({})
	store.bind(ev)
	ev.emit('chats.upsert', [{ id: '1@s.whatsapp.net', conversationTimestamp: 1 }])
	ok('chat stored', !!store.chats.get('1@s.whatsapp.net'))
	store.writeToFile('/tmp/easy-store-test.json')
	const store2 = makeInMemoryStore({})
	store2.readFromFile('/tmp/easy-store-test.json')
	ok('persist + read back', !!store2.chats.get('1@s.whatsapp.net'))
}

console.log('— easySocketDefaults')
ok('defaults object', typeof easy.easySocketDefaults === 'object' && easy.easySocketDefaults.markOnlineOnConnect === false)

console.log('— interactive: nativeFlow buttons')
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', {
	text: 'pick one',
	footer: 'footer here',
	nativeFlow: [
		{ id: 'yes', text: 'Yes' },
		{ id: 'no', text: 'No' },
		{ url: 'https://example.com', text: 'Visit' },
		{ copy: 'ABC123', text: 'Copy code' },
		{ call: '+123456789', text: 'Call us' }
	]
})
{
	const s = last()
	const inner = normalizeMessageContent(s.message)
	ok('interactiveMessage built', !!inner.interactiveMessage)
	ok('viewOnce wrapper', !!s.message.viewOnceMessage)
	const btns = inner.interactiveMessage.nativeFlowMessage.buttons
	ok('5 buttons', btns.length === 5)
	ok('quick_reply first', btns[0].name === 'quick_reply' && JSON.parse(btns[0].buttonParamsJson).id === 'yes')
	ok('cta_url', btns[2].name === 'cta_url')
	ok('cta_copy', btns[3].name === 'cta_copy')
	ok('cta_call', btns[4].name === 'cta_call')
	ok('body text', inner.interactiveMessage.body.text === 'pick one')
	const biz = s.opts.additionalNodes.find(n => n.tag === 'biz')
	ok('biz node present', !!biz)
	ok('biz has mixed native_flow', JSON.stringify(biz).includes('"name":"mixed"'))
	ok('bot node in 1:1', s.opts.additionalNodes.some(n => n.tag === 'bot'))
	// proto round-trip
	const enc = proto.Message.encode(s.message).finish()
	ok('proto round-trip', !!proto.Message.decode(enc).viewOnceMessage)
}

console.log('— interactive: buttonParamsJson alias')
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', {
	text: 'raw flow',
	nativeFlow: [
		{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Go', id: 'g1' }) },
		{ name: 'cta_url', paramsJson: JSON.stringify({ display_text: 'Web', url: 'https://example.com' }) }
	]
})
{
	const btns = normalizeMessageContent(last().message).interactiveMessage.nativeFlowMessage.buttons
	ok('buttonParamsJson accepted', JSON.parse(btns[0].buttonParamsJson).id === 'g1')
	ok('paramsJson still accepted', JSON.parse(btns[1].buttonParamsJson).display_text === 'Web')
}

console.log('— interactive: no bot node in groups')
reset()
await easy.sendEasyMessage(mockSock, '120363000000@g.us', {
	text: 'pick one',
	nativeFlow: [{ id: 'yes', text: 'Yes' }]
})
{
	const s = last()
	ok('biz node present', s.opts.additionalNodes.some(n => n.tag === 'biz'))
	ok('no bot node in group', !s.opts.additionalNodes.some(n => n.tag === 'bot'))
}

console.log('— interactive: single_select shortcut')
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', {
	text: 'choose',
	nativeFlow: [{ text: 'Options', sections: [{ title: 'S1', rows: [{ title: 'R1', rowId: 'r1' }] }] }]
})
{
	const btns = normalizeMessageContent(last().message).interactiveMessage.nativeFlowMessage.buttons
	ok('single_select', btns[0].name === 'single_select')
}

console.log('— interactive: buttons (legacy buttonsMessage)')
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', {
	text: 'legacy',
	buttons: [{ id: 'b1', text: 'Tap me' }, { text: 'Pick', sections: [{ title: 'S', rows: [] }] }]
})
{
	const s = last()
	const bm = s.message.buttonsMessage
	ok('buttonsMessage', !!bm && bm.buttons.length === 2)
	ok('response type', bm.buttons[0].type === proto.Message.ButtonsMessage.Button.Type.RESPONSE)
	ok('native_flow single_select', bm.buttons[1].type === proto.Message.ButtonsMessage.Button.Type.NATIVE_FLOW)
	ok('biz node for buttonsMessage', s.opts.additionalNodes.some(n => n.tag === 'biz'))
}

console.log('— interactive: sections (listMessage)')
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', {
	text: 'list desc',
	title: 'list title',
	buttonText: 'Open',
	sections: [{ title: 'S1', rows: [{ title: 'R1', rowId: 'r1', description: 'd1' }] }]
})
{
	const s = last()
	const lm = s.message.listMessage
	ok('listMessage', !!lm && lm.sections.length === 1)
	ok('listType single_select', lm.listType === proto.Message.ListMessage.ListType.SINGLE_SELECT)
	const biz = s.opts.additionalNodes.find(n => n.tag === 'biz')
	ok('biz node has list type', JSON.stringify(biz).includes('product_list'))
}

console.log('— interactive: templateButtons')
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', {
	text: 'tpl',
	templateButtons: [
		{ id: 'q1', text: 'Quick' },
		{ url: 'https://example.com', text: 'Web' },
		{ call: '+123', text: 'Call' }
	]
})
{
	const s = last()
	const tm = s.message.templateMessage
	ok('templateMessage', !!tm)
	ok('3 hydrated buttons', tm.hydratedTemplate.hydratedButtons.length === 3)
	ok('quickReplyButton', !!tm.hydratedTemplate.hydratedButtons[0].quickReplyButton)
	ok('urlButton', !!tm.hydratedTemplate.hydratedButtons[1].urlButton)
	ok('callButton', !!tm.hydratedTemplate.hydratedButtons[2].callButton)
	ok('biz node', s.opts.additionalNodes.some(n => n.tag === 'biz'))
}

console.log('— interactive: media header + carousel')
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', {
	caption: 'with image header',
	nativeFlow: [{ id: 'ok', text: 'OK' }],
	image: PNG
})
{
	const inner = normalizeMessageContent(last().message)
	ok('media header attached', !!inner.interactiveMessage.header.imageMessage)
	ok('hasMediaAttachment', inner.interactiveMessage.header.hasMediaAttachment === true)
}
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', {
	cards: [
		{ image: PNG, text: 'card one', nativeFlow: [{ id: 'c1', text: 'Go' }] },
		{ image: PNG, text: 'card two', nativeFlow: [{ url: 'https://example.com', text: 'Web' }] }
	]
})
{
	const s = last()
	const cm = normalizeMessageContent(s.message).interactiveMessage.carouselMessage
	ok('carousel 2 cards', cm.cards.length === 2)
	ok('card buttons', cm.cards[0].nativeFlowMessage.buttons[0].name === 'quick_reply')
	ok('no biz node for carousel (fork parity)', !s.opts.additionalNodes.some(n => n.tag === 'biz'))
	ok('viewOnce wrapper', !!s.message.viewOnceMessage)
}

console.log('— interactive: caption without media throws')
{
	let threw = false
	try {
		await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', {
			caption: 'no media', nativeFlow: [{ id: 'x', text: 'X' }]
		})
	} catch { threw = true }
	ok('throws', threw)
}

console.log('— interactiveAsTemplate with nativeFlow')
reset()
await easy.sendEasyMessage(mockSock, '1234567890@s.whatsapp.net', {
	text: 'as template',
	nativeFlow: [{ id: 't1', text: 'T' }],
	interactiveAsTemplate: true
})
{
	const m = last().message
	ok('templateMessage wrapper', !!m.templateMessage?.interactiveMessageTemplate)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
