/**
 * baileys-easy — the "easy" extras from the itsliaaa/baileys fork,
 * re-implemented as a side helper on top of official @whiskeysockets/baileys.
 *
 * No Baileys source is patched. Everything goes through official exports:
 * generateWAMessageContent / generateWAMessageFromContent / generateWAMessage /
 * prepareWAMessageMedia / proto / sock.relayMessage.
 *
 * What's inside (all rated "easy" to port):
 *   - `mentionAll` (+ `mentions` passthrough)
 *   - `groupStatus` (contextInfo.isGroupStatus + groupStatusMessageV2 wrapper)
 *   - `interactiveAsTemplate` (wrap interactiveMessage in templateMessage)
 *   - `ephemeral`, `isLottie`
 *   - `ai` (Meta AI badge: supportPayload + bot node, 1:1 chats only)
 *   - `raw` (pass a pre-built proto message object straight through)
 *   - reply builders: `buttonReply`, `listReply`, `flowReply`
 *   - `album` (parent albumMessage + media items linked via messageAssociation)
 *   - interactive: `buttons` (quick_reply/cta/single_select), `sections` (lists),
 *     `templateButtons`, `nativeFlow` — with the fork's biz
 *     binary node + bot node on send, and the viewOnce wrapper interactive
 *     messages need to render tappable
 *   - `deviceListMetadata` injection for 1:1 chats (automatic, like the fork)
 *   - manual quoting inside newsletters (official skips `quoted` there)
 *   - `findUserId(sock, id)` — PN<->LID via the socket's signalRepository
 *   - `makeInMemoryStore` — re-implemented externally (see ./store/)
 *
 * Deliberately NOT included (need proto changes or deep internals):
 *   spoiler, sticker packs, native flows/carousels, rich responses,
 *   newsletter media upload paths, incoming edit decryption.
 */

import {
	generateWAMessageContent,
	generateWAMessageFromContent,
	generateWAMessage,
	normalizeMessageContent,
	getContentType,
	prepareWAMessageMedia,
	delay,
	generateMessageIDV2,
	unixTimestampSeconds,
	proto,
	isJidNewsletter,
	isPnUser,
	isLidUser,
	isJidGroup,
	jidNormalizedUser,
	WAMessageStatus,
	WA_DEFAULT_EPHEMERAL
} from '@whiskeysockets/baileys'
import { randomBytes } from 'crypto'

const EPHEMERAL_DEFAULT = typeof WA_DEFAULT_EPHEMERAL === 'number' ? WA_DEFAULT_EPHEMERAL : 7 * 24 * 60 * 60

/** Same constant the fork uses for the AI badge (Defaults). */
const BIZ_BOT_SUPPORT_PAYLOAD = '{"version":1,"is_ai_message":true,"should_upload_client_logs":false,"should_show_system_message":false,"ticket_id":"7004947587700716","citation_items":[],"ticket_locale":"us"}'

/** Content keys consumed by this helper (never passed to official generateWAMessageContent). */
const EASY_FLAGS = [
	'raw', 'mentionAll', 'groupStatus', 'interactiveAsTemplate',
	'ephemeral', 'isLottie',
	'ai',
	'buttonReply', 'listReply', 'flowReply', 'album',
	'buttons', 'sections', 'templateButtons', 'nativeFlow'
]

const splitEasyFlags = (content = {}) => {
	const flags = {}
	const rest = {}
	for (const [k, v] of Object.entries(content)) {
		if (EASY_FLAGS.includes(k)) flags[k] = v
		else rest[k] = v
	}
	return { flags, rest }
}

const prepareProductMessage = async (message, mediaCtx) => {
	if (!message.businessOwnerJid) {
		throw new Error('"businessOwnerJid" is missing from the product content')
	}
	const { imageMessage } = await prepareWAMessageMedia({ image: message.image || message.product?.productImage }, mediaCtx)
	const { image, ...content } = message
	content.product = {
		currencyCode: 'IDR',
		priceAmount1000: 1000,
		title: 'baileys-easy',
		inStockQuantity: 0,
		...message.product,
		productImage: imageMessage
	}
	return content
}

/* ------------------------------------------------------------------ */
/* Interactive messages (buttons / lists / templates / native flows /   */
/* carousels) — ported from the itsliaaa/baileys fork's builders.       */
/* Sending goes through relayMessage with the fork's biz binary node    */
/* (see getBizBinaryNode below) plus the bot node in 1:1 chats.         */
/* ------------------------------------------------------------------ */

/** Map a native-flow button definition to { name, buttonParamsJson }. */
const prepareNativeFlowButtons = (nativeFlow, message = {}) => {
	const raw = nativeFlow?.nativeFlow ?? nativeFlow
	const list = Array.isArray(raw) ? raw : raw.buttons
	if (!Array.isArray(list)) throw new Error('nativeFlow must be an array of buttons or { buttons: [...] }')
	const messageParamsJson = {}
	if (message.offerText) {
		Object.assign(messageParamsJson, {
			limited_time_offer: {
				text: message.offerText,
				url: message.offerUrl || 'https://github.com/meowguck-art/baileys-easy',
				copy_code: message.offerCode,
				expiration_time: message.offerExpiration
			}
		})
	}
	if (message.optionText) {
		Object.assign(messageParamsJson, {
			bottom_sheet: {
				in_thread_buttons_limit: 1,
				divider_indices: Array.from({ length: list.length }, (_, i) => i),
				list_title: message.optionTitle || 'Select Options',
				button_title: message.optionText
			}
		})
	}
	return {
		buttons: list.map(button => {
			const buttonText = button.text || button.buttonText
			const buttonIcon = button.icon?.toUpperCase()
			if (button.id) {
				return {
					name: 'quick_reply',
					buttonParamsJson: JSON.stringify({
						display_text: buttonText || 'Click',
						id: button.id,
						icon: buttonIcon
					})
				}
			}
			if (button.copy) {
				return {
					name: 'cta_copy',
					buttonParamsJson: JSON.stringify({
						display_text: buttonText || 'Copy',
						copy_code: button.copy,
						icon: buttonIcon
					})
				}
			}
			if (button.url) {
				return {
					name: 'cta_url',
					buttonParamsJson: JSON.stringify({
						display_text: buttonText || 'Visit',
						url: button.url,
						merchant_url: button.url,
						webview_interaction: button.useWebview,
						icon: buttonIcon
					})
				}
			}
			if (button.call) {
				return {
					name: 'cta_call',
					buttonParamsJson: JSON.stringify({
						display_text: buttonText || 'Call',
						phone_number: button.call,
						icon: buttonIcon
					})
				}
			}
			if (button.sections) {
				return {
					name: 'single_select',
					buttonParamsJson: JSON.stringify({
						title: buttonText || 'Select',
						sections: button.sections,
						icon: buttonIcon
					})
				}
			}
			if (button.name) {
				return {
					name: button.name,
					buttonParamsJson: button.buttonParamsJson ?? button.paramsJson
				}
			}
			return button
		}),
		messageParamsJson: JSON.stringify(messageParamsJson)
	}
}

/** The fork's interactiveMessage MUST be wrapped in viewOnceMessage with
 *  messageContextInfo inside — a top-level interactiveMessage renders with
 *  disabled/grayed-out buttons (verified on real clients). */
const wrapInteractiveViewOnce = (interactiveMessage) => ({
	viewOnceMessage: {
		message: {
			messageContextInfo: {
				deviceListMetadata: {},
				deviceListMetadataVersion: 2
			},
			interactiveMessage
		}
	}
})

const hasValidInteractiveHeader = (message) => !!(
	message.imageMessage || message.videoMessage || message.documentMessage || message.productMessage
)

const buildInteractiveBody = (target, rest) => {
	if (rest.text !== undefined) {
		target.body = { text: rest.text }
		return 'text'
	}
	if (rest.caption !== undefined) {
		target.body = { text: rest.caption }
		return 'caption'
	}
	return null
}

/**
 * Build buttonsMessage / listMessage / templateMessage / interactiveMessage
 * (nativeFlow or carousel). `base` is the already-built media object (for
 * headers), `rest` the remaining friendly content (text/caption/footer/...).
 */
const buildInteractiveMessage = async (flags, rest, base, mediaCtx) => {
	const { footer, title, subtitle, thumbnail } = rest

	if (flags.buttons !== undefined) {
		const ButtonType = proto.Message.ButtonsMessage.Button.Type
		const ButtonHeaderType = proto.Message.ButtonsMessage.HeaderType
		const buttonsMessage = {
			buttons: flags.buttons.map(button => {
				const buttonText = button.text || button.buttonText
				if (button.sections) {
					return {
						nativeFlowInfo: {
							name: 'single_select',
							paramsJson: JSON.stringify({ title: buttonText, sections: button.sections })
						},
						type: ButtonType.NATIVE_FLOW
					}
				}
				if (button.name) {
					return {
						nativeFlowInfo: { name: button.name, paramsJson: button.buttonParamsJson ?? button.paramsJson },
						type: ButtonType.NATIVE_FLOW
					}
				}
				return {
					buttonId: button.id || button.buttonId,
					buttonText: typeof buttonText === 'string' ? { displayText: buttonText } : buttonText,
					type: button.type || ButtonType.RESPONSE
				}
			})
		}
		if (rest.text !== undefined) {
			buttonsMessage.contentText = rest.text
			buttonsMessage.headerType = ButtonHeaderType.EMPTY
		}
		else {
			if (rest.caption !== undefined) buttonsMessage.contentText = rest.caption
			const mediaType = Object.keys(base)[0]
			if (!mediaType || !hasValidInteractiveHeader(base)) {
				throw new Error('buttons with caption needs an image/video/document header')
			}
			buttonsMessage.headerType = ButtonHeaderType[mediaType.replace('Message', '').toUpperCase()]
			Object.assign(buttonsMessage, base)
		}
		if (footer !== undefined) buttonsMessage.footerText = footer
		return { buttonsMessage }
	}

	if (flags.sections !== undefined) {
		return {
			listMessage: {
				sections: flags.sections,
				buttonText: rest.buttonText,
				title: rest.title,
				footerText: footer,
				description: rest.text,
				listType: proto.Message.ListMessage.ListType.SINGLE_SELECT
			}
		}
	}

	if (flags.templateButtons !== undefined) {
		const hydratedTemplate = {
			hydratedButtons: flags.templateButtons.map((button, i) => {
				const buttonText = button.text || button.buttonText
				if (button.id) {
					return { index: i, quickReplyButton: { displayText: buttonText || 'Click', id: button.id } }
				}
				if (button.url) {
					return { index: i, urlButton: { displayText: buttonText || 'Visit', url: button.url } }
				}
				if (button.call) {
					return { index: i, callButton: { displayText: buttonText || 'Call', phoneNumber: button.call } }
				}
				button.index = button.index ?? i
				return button
			})
		}
		if (rest.text !== undefined) {
			hydratedTemplate.hydratedContentText = rest.text
		}
		else {
			if (rest.caption !== undefined) {
				hydratedTemplate.hydratedTitleText = title
				hydratedTemplate.hydratedContentText = rest.caption
			}
			Object.assign(hydratedTemplate, base)
		}
		if (footer !== undefined) hydratedTemplate.hydratedFooterText = footer
		hydratedTemplate.templateId = rest.id || 'template-' + Date.now()
		return { templateMessage: { hydratedFourRowTemplate: hydratedTemplate, hydratedTemplate } }
	}

	if (flags.nativeFlow !== undefined) {
		const interactiveMessage = {
			nativeFlowMessage: prepareNativeFlowButtons(flags.nativeFlow, rest)
		}
		if (rest.bizJid) {
			interactiveMessage.collectionMessage = { bizJid: rest.bizJid, id: rest.id, messageVersion: 1 }
		}
		else if (rest.shopSurface) {
			interactiveMessage.shopStorefrontMessage = { surface: rest.shopSurface, id: rest.id, messageVersion: 1 }
		}
		const mode = buildInteractiveBody(interactiveMessage, rest)
		if (mode === 'caption') {
			if (!hasValidInteractiveHeader(base)) {
				throw new Error('nativeFlow with caption needs an image/video/document header')
			}
			interactiveMessage.header = {
				title: title || '',
				subtitle: subtitle || '',
				hasMediaAttachment: true,
				...base
			}
			if (thumbnail) interactiveMessage.jpegThumbnail = thumbnail
		}
		if (rest.audioFooter) {
			const { audioMessage } = await prepareWAMessageMedia({ audio: rest.audioFooter }, mediaCtx)
			interactiveMessage.footer = { audioMessage, hasMediaAttachment: true }
		}
		else if (footer !== undefined) {
			interactiveMessage.footer = { text: footer }
		}
		return wrapInteractiveViewOnce(interactiveMessage)
	}

	// flags.cards — carousel
	const interactiveMessage = {
		carouselMessage: {
			cards: await Promise.all(flags.cards.map(async (card) => {
				let carouselHeader = {}
				if (card.product) {
					carouselHeader.productMessage = await prepareProductMessage(card, mediaCtx)
				}
				else {
					carouselHeader = await prepareWAMessageMedia(card, mediaCtx).catch(() => ({}))
				}
				if (!hasValidInteractiveHeader(carouselHeader)) {
					throw new Error('carousel card needs an image/video/document/product header')
				}
				const carouselCard = {
					nativeFlowMessage: prepareNativeFlowButtons(card.nativeFlow || card.buttons ? card : [])
				}
				const mode = buildInteractiveBody(carouselCard, card)
				if (mode === 'caption') {
					carouselCard.header = {
						title: card.title || '',
						subtitle: card.subtitle || '',
						hasMediaAttachment: true,
						...carouselHeader
					}
					if (card.thumbnail) carouselCard.jpegThumbnail = card.thumbnail
				}
				if (card.audioFooter) {
					const { audioMessage } = await prepareWAMessageMedia({ audio: card.audioFooter }, mediaCtx)
					carouselCard.footer = { audioMessage, hasMediaAttachment: true }
				}
				else if (card.footer !== undefined) {
					carouselCard.footer = { text: card.footer }
				}
				return carouselCard
			})),
			carouselCardType: proto.Message.InteractiveMessage.CarouselMessage.CarouselCardType.UNKNOWN,
			messageVersion: 1
		}
	}
	if (rest.text !== undefined) interactiveMessage.body = { text: rest.text }
	if (footer !== undefined) interactiveMessage.footer = { text: footer }
	return wrapInteractiveViewOnce(interactiveMessage)
}

/* ------------------------------------------------------------------ */
/* Biz binary node — the stanza wrapper WhatsApp expects around        */
/* interactive messages (ported from the fork's WABinary).             */
/* ------------------------------------------------------------------ */

const FLOWS_MAP = {
	mpm: true,
	cta_catalog: true,
	send_location: true,
	call_permission_request: true,
	wa_payment_transaction_details: true,
	automated_greeting_message_view_catalog: true
}
const DECISION_SOURCE_CONTENT = [{ tag: 'decision_source', attrs: { value: 'df' } }]
const LIST_TYPE_CONTENT = { tag: 'list', attrs: { v: '2', type: 'product_list' } }
const NATIVE_FLOW_ATTRIBUTE = { type: 'native_flow', v: '1' }
const MIXED_NATIVE_FLOW = {
	tag: 'interactive',
	attrs: NATIVE_FLOW_ATTRIBUTE,
	content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
}

const getBizBinaryNode = (message) => {
	const flowMsg = message.interactiveMessage?.nativeFlowMessage
	const firstButtonName = flowMsg?.buttons?.[0]?.name
	const qualityContent = {
		tag: 'quality_control',
		attrs: {
			decision_id: randomBytes(20).toString('hex'),
			source_type: 'third_party'
		},
		content: DECISION_SOURCE_CONTENT
	}
	const bizAttributes = {
		actual_actors: '2',
		host_storage: '2',
		privacy_mode_ts: `${Date.now() / 1_000 | 0}`
	}
	if (firstButtonName === 'review_and_pay' || firstButtonName === 'payment_info') {
		bizAttributes.native_flow_name = firstButtonName === 'review_and_pay' ? 'order_details' : firstButtonName
		return { tag: 'biz', attrs: bizAttributes, content: [qualityContent] }
	}
	if (firstButtonName && FLOWS_MAP[firstButtonName]) {
		return {
			tag: 'biz',
			attrs: bizAttributes,
			content: [
				{
					tag: 'interactive',
					attrs: NATIVE_FLOW_ATTRIBUTE,
					content: [{ tag: 'native_flow', attrs: { v: '2', name: firstButtonName } }]
				},
				qualityContent
			]
		}
	}
	if (flowMsg || message.buttonsMessage || message.templateMessage) {
		return { tag: 'biz', attrs: bizAttributes, content: [MIXED_NATIVE_FLOW, qualityContent] }
	}
	if (message.listMessage) {
		return { tag: 'biz', attrs: bizAttributes, content: [LIST_TYPE_CONTENT, qualityContent] }
	}
	return { tag: 'biz', attrs: bizAttributes, content: [qualityContent] }
}

const shouldIncludeBizBinaryNode = (message) => !!(
	message.buttonsMessage ||
	message.listMessage ||
	message.templateMessage ||
	(message.interactiveMessage && message.interactiveMessage.nativeFlowMessage)
)

/** Friendly content -> proto-ready plain object (mirrors the fork's added branches). */
const buildProtoMessage = async (content, mediaCtx) => {
	const { flags, rest } = splitEasyFlags(content)
	let m

	if (flags.raw !== undefined) {
		// pre-built proto message object, sent as-is
		m = { ...flags.raw }
	}
	else if (flags.buttonReply) {
		m = rest.type === 'template'
			? {
				templateButtonReplyMessage: {
					selectedDisplayText: flags.buttonReply.displayText,
					selectedId: flags.buttonReply.id,
					selectedIndex: flags.buttonReply.index
				}
			}
			: {
				buttonsResponseMessage: {
					selectedButtonId: flags.buttonReply.id,
					selectedDisplayText: flags.buttonReply.displayText,
					type: proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT
				}
			}
	}
	else if (flags.listReply) {
		m = {
			listResponseMessage: {
				description: flags.listReply.description,
				listType: proto.Message.ListResponseMessage.ListType.SINGLE_SELECT,
				singleSelectReply: { selectedRowId: flags.listReply.id },
				title: flags.listReply.title
			}
		}
	}
	else if (flags.flowReply) {
		m = {
			interactiveResponseMessage: {
				body: {
					format: flags.flowReply.format || proto.Message.InteractiveResponseMessage.Body.Format.DEFAULT,
					text: flags.flowReply.text
				},
				nativeFlowResponseMessage: {
					name: flags.flowReply.name,
					paramsJson: flags.flowReply.paramsJson || '{}',
					version: flags.flowReply.version || 1
				}
			}
		}
	}
	else if (flags.album) {
		const items = flags.album
		if (!Array.isArray(items)) throw new Error('album must be an array of media contents')
		let imageCount = 0, videoCount = 0
		for (const item of items) {
			if (item.image) imageCount++
			if (item.video) videoCount++
		}
		if (imageCount + videoCount < 2) throw new Error('album needs at least 2 media items')
		m = { albumMessage: { expectedImageCount: imageCount, expectedVideoCount: videoCount } }
	}
	else if (flags.buttons !== undefined || flags.sections !== undefined ||
		flags.templateButtons !== undefined || flags.nativeFlow !== undefined) {
		// like the fork's chain: build base media first (for headers), then the interactive branch
		const { image, video, audio, document, sticker } = rest
		const baseMedia = { image, video, audio, document, sticker }
		for (const k of Object.keys(baseMedia)) {
			if (baseMedia[k] === undefined) delete baseMedia[k]
		}
		const base = Object.keys(baseMedia).length ? await generateWAMessageContent(baseMedia, mediaCtx) : {}
		m = await buildInteractiveMessage(flags, rest, base, mediaCtx)
	}
	else {
		// standard content — delegate to the official builder
		m = await generateWAMessageContent(rest, mediaCtx)
	}

	return { m, flags }
}

/** Structural wrappers (ephemeral / lottie / template / groupStatus). */
const applyWrappers = (m, flags) => {
	// wrap but keep messageContextInfo outside the wrapper (official parity:
	// generateWAMessageContent adds it AFTER wrapping, so it stays top-level)
	const wrapHoisted = (msg, wrapper) => {
		const { messageContextInfo, ...rest } = msg
		const wrapped = { [wrapper]: { message: rest } }
		if (messageContextInfo !== undefined) wrapped.messageContextInfo = messageContextInfo
		return wrapped
	}
	if (flags.interactiveAsTemplate) {
		const normalized = normalizeMessageContent(m)
		if (!normalized?.interactiveMessage) throw new Error('interactiveAsTemplate needs an interactiveMessage')
		m = {
			templateMessage: {
				interactiveMessageTemplate: normalized.interactiveMessage,
				templateId: 'template-' + Date.now()
			}
		}
	}
	if (flags.ephemeral) {
		m = wrapHoisted(m, 'ephemeralMessage')
	}
	if (flags.isLottie) {
		m = { lottieStickerMessage: { message: m } }
	}
	if (flags.groupStatus) {
		const messageType = Object.keys(m)[0]
		const key = m[messageType]
		if (key) {
			key.contextInfo = key.contextInfo || {}
			key.contextInfo.isGroupStatus = true
		}
		m = { groupStatusMessageV2: { message: m } }
	}
	return m
}

/** contextInfo-level tweaks on the plain proto object. */
const applyEasyContextInfo = (m, flags, { jid, mentions }) => {
	const inner = normalizeMessageContent(m)
	const key = getContentType(inner)
	const target = inner[key]
	if (!target || typeof target !== 'object') return

	target.contextInfo = target.contextInfo || {}

	if ((mentions && mentions.length) || flags.mentionAll) {
		if (mentions && mentions.length) target.contextInfo.mentionedJid = mentions
		if (flags.mentionAll) target.contextInfo.nonJidMentions = 1
	}

	// fork parity: deviceListMetadata inside messageContextInfo for 1:1 chats
	if (m.messageContextInfo?.messageSecret && (isPnUser(jid) || isLidUser(jid))) {
		m.messageContextInfo.deviceListMetadata = {
			recipientKeyHash: randomBytes(10),
			recipientTimestamp: unixTimestampSeconds()
		}
		m.messageContextInfo.deviceListMetadataVersion = 2
	}
}

/**
 * Enhanced sendMessage. `content` is the usual Baileys content object
 * ({ text, image, video, ... }) plus any of the easy flags documented above.
 *
 * @param {object} sock   Baileys socket (needs relayMessage + waUploadToServer)
 * @param {string} jid    destination
 * @param {object} content friendly content + easy flags
 * @param {object} [options]
 * @param {object} [options.quoted]
 * @param {string} [options.userJid]
 * @param {string} [options.messageId]
 * @param {Date}   [options.timestamp]
 * @param {Function} [options.upload]      custom media uploader (default: sock.waUploadToServer)
 * @param {Array}  [options.additionalNodes]
 * @param {number} [options.albumDelayMs]  ms between album items (default 1500)
 * @param {Array}  [options.mentions]      also passed as regular mentions
 * @returns the sent WebMessageInfo
 */
export const sendEasyMessage = async (sock, jid, content, options = {}) => {
	const mediaCtx = {
		jid,
		upload: options.upload || sock.waUploadToServer?.bind(sock),
		mediaCache: options.mediaCache,
		getUrlInfo: options.getUrlInfo,
		...(options.mediaOptions || {})
	}

	const { m: built, flags } = await buildProtoMessage(content, mediaCtx)
	let m = applyWrappers(built, flags)

	const isNewsletter = isJidNewsletter(jid)

	// official generateWAMessageFromContent skips `quoted` for newsletters —
	// build the quote manually so it works in channels too
	if (isNewsletter && options.quoted) {
		const inner = normalizeMessageContent(m)
		const key = getContentType(inner)
		let quotedMsg = normalizeMessageContent(options.quoted.message)
		const msgType = getContentType(quotedMsg)
		quotedMsg = proto.Message.create({ [msgType]: quotedMsg[msgType] })
		if (quotedMsg[msgType]?.contextInfo) delete quotedMsg[msgType].contextInfo
		const participant = options.quoted.key.fromMe
			? (options.userJid || sock.user?.id)
			: options.quoted.participant || options.quoted.key.participant || options.quoted.key.remoteJid
		inner[key].contextInfo = {
			...(inner[key].contextInfo || {}),
			participant: jidNormalizedUser(participant),
			stanzaId: options.quoted.key.id,
			quotedMessage: quotedMsg
		}
	}

	applyEasyContextInfo(m, flags, { jid, mentions: options.mentions || content.mentions })

	const additionalNodes = [...(options.additionalNodes || [])]
	if (flags.ai) {
		if (!isPnUser(jid) && !isLidUser(jid)) {
			throw new Error('ai is only supported in 1:1 chats')
		}
		m.messageContextInfo = m.messageContextInfo || {}
		m.messageContextInfo.supportPayload = BIZ_BOT_SUPPORT_PAYLOAD
		additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } })
	}

	const waMsg = generateWAMessageFromContent(jid, m, {
		quoted: !isNewsletter ? options.quoted : undefined,
		userJid: options.userJid || sock.user?.id,
		messageId: options.messageId,
		timestamp: options.timestamp,
		ephemeralExpiration: options.ephemeralExpiration
	})

	// interactive messages need the biz binary node or WhatsApp drops them;
	// in 1:1 chats they also need the bot node (AI badge)
	const normalized = normalizeMessageContent(waMsg.message)
	if (shouldIncludeBizBinaryNode(normalized) && !additionalNodes.some(n => n.tag === 'biz')) {
		additionalNodes.push(getBizBinaryNode(normalized))
		if ((isPnUser(jid) || isLidUser(jid)) && !additionalNodes.some(n => n.tag === 'bot')) {
			additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } })
		}
	}

	await sock.relayMessage(jid, waMsg.message, {
		messageId: waMsg.key.id,
		additionalNodes,
		...(options.relayOptions || {})
	})

	// album: every media item is its own message linked to the parent
	if (flags.album) {
		const delayMs = options.albumDelayMs ?? 1500
		for (const item of flags.album) {
			const itemMsg = await generateWAMessage(jid, item, {
				userJid: options.userJid || sock.user?.id,
				upload: mediaCtx.upload,
				mediaCache: mediaCtx.mediaCache,
				messageId: generateMessageIDV2()
			})
			const norm = normalizeMessageContent(itemMsg.message)
			if (!norm.imageMessage && !norm.videoMessage) {
				throw new Error('album items must be image or video messages')
			}
			itemMsg.message.messageContextInfo = itemMsg.message.messageContextInfo || {}
			itemMsg.message.messageContextInfo.messageAssociation = {
				parentMessageKey: waMsg.key,
				associationType: proto.MessageAssociation.AssociationType.MEDIA_ALBUM
			}
			await sock.relayMessage(jid, itemMsg.message, {
				messageId: itemMsg.key.id,
				additionalNodes: options.additionalNodes
			})
			await delay(delayMs)
		}
	}

	return waMsg
}

/**
 * Resolve a PN<->LID id using the socket's signal repository
 * (fork's findUserId, re-implemented against the official socket).
 * Returns { lid, phoneNumber } with normalized JIDs (undefined when unknown).
 */
export const findUserId = async (sock, pnLid) => {
	const lidMapping = sock.signalRepository?.lidMapping
	if (!lidMapping) throw new Error('socket has no signalRepository.lidMapping')
	const normalizedJid = jidNormalizedUser(pnLid)
	const userId = { lid: undefined, phoneNumber: undefined }
	if (isPnUser(normalizedJid)) {
		userId.phoneNumber = normalizedJid
		userId.lid = jidNormalizedUser((await lidMapping.getLIDsForPNs([normalizedJid]))?.[0]?.lid)
	}
	else if (isLidUser(normalizedJid)) {
		userId.lid = normalizedJid
		userId.phoneNumber = jidNormalizedUser((await lidMapping.getPNsForLIDs([normalizedJid]))?.[0]?.pn)
	}
	else {
		throw new Error('Invalid id input to find user ids')
	}
	return userId
}

/**
 * The fork's makeWASocket config defaults, as a plain object you can spread
 * into your own makeWASocket() call.
 */
export const easySocketDefaults = {
	markOnlineOnConnect: false,
	shouldSyncHistoryMessage: () => false,
	syncFullHistory: false,
	transactionOpts: { maxCommitRetries: 5, delayBetweenTriesMs: 3000 },
	getMessage: async () => undefined
}

export { makeInMemoryStore } from './store/make-in-memory-store.mjs'
export { WAMessageStatus }
