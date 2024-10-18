function doPost(e: GoogleAppsScript.Events.DoPost) {
    var slackVerificationToken =
        PropertiesService.getScriptProperties().getProperty(
            'SLACK_VERIFICATION_TOKEN'
        )
    var slackBotToken =
        PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN')
    var sheetApp = SpreadsheetApp.openById(
        PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')
    )
    var payload = JSON.parse(e.postData.contents)
    var searchLogs = sheetApp.getSheetByName('usagelogs')
    var errorLogs = sheetApp.getSheetByName('errorlogs')

    // Slack Event SubscriptionのURL verification
    if (payload.type === 'url_verification') {
        return ContentService.createTextOutput(payload.challenge).setMimeType(
            ContentService.MimeType.TEXT
        )
    }

    // 知らないVerification Tokenが送られてきたらエラー
    if (payload.token != slackVerificationToken) {
        return ContentService.createTextOutput(
            'Invalid verification token.'
        ).setMimeType(ContentService.MimeType.TEXT)
    }

    try {
        if (payload.event.type === 'assistant_thread_started') {
            var user_id = payload.event.assistant_thread.user_id
            var ch_id = payload.event.assistant_thread.channel_id
            var ch_ts = payload.event.assistant_thread.thread_ts
            // CacheServiceにすでに保存されている場合は無視
            const cacheKey = `${user_id}-${ch_id}-${ch_ts}`
            if (CacheService.getScriptCache().get(cacheKey)) {
                return ContentService.createTextOutput('OK').setMimeType(
                    ContentService.MimeType.TEXT
                )
            }
            // CacheServiceに保存
            CacheService.getScriptCache().put(cacheKey, payload.event_id)

            var messageBlocks = [
                {
                    color: '#0000ff',
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: `<@${user_id}> さんこんにちは！`,
                            },
                        },
                        {
                            type: 'divider',
                        },
                    ],
                },
            ]
            postToSlackWithBlockKit(slackBotToken, messageBlocks, ch_id, ch_ts)
        } else if (payload.event.type === 'message') {
            // Bot自身のメッセージは無視
            if (payload.event.bot_id) {
                return ContentService.createTextOutput('OK').setMimeType(
                    ContentService.MimeType.TEXT
                )
            }

            var ch_id = payload.event.channel
            var user_id = 'unknown-user' as any
            var ch_ts = 'unknown-ts' as any
            var text = 'unknown-text'
            var timestamp = 'unknown-ts'
            if (payload.event.message) {
                user_id =
                    payload.event.message.reply_users[
                        payload.event.message.reply_users_count
                    ]
                ch_ts = payload.event.message.ts
                text = payload.event.message.assistant_app_thread.title
                timestamp = payload.event.message.latest_reply
            } else {
                user_id = payload.event.user
                ch_ts = payload.event.thread_ts
                text = payload.event.text
                timestamp = payload.event.event_ts
            }

            // CacheServiceにすでに保存されている場合は無視
            const cacheKey = `${ch_id}-${ch_ts}-${timestamp}`
            if (CacheService.getScriptCache().get(cacheKey)) {
                return ContentService.createTextOutput('OK').setMimeType(
                    ContentService.MimeType.TEXT
                )
            }

            // CacheServiceに保存
            CacheService.getScriptCache().put(cacheKey, payload.event_id)

            // ステータスを更新
            if (payload.event.message) {
                setStatus(
                    slackBotToken,
                    ch_id,
                    ch_ts,
                    'Botが考えています...'
                )
            }

            // WordPressのAPIを叩いて検索結果を取得
            const searchResult = wpSearch(text)
            const body = [
                {
                    color: '#0000ff',
                    blocks: searchResult,
                },
            ]

            // 検索結果をSlackに投稿
            postToSlackWithBlockKit(slackBotToken, body, ch_id, ch_ts)

            // logに書き込み
            var ar = [user_id, text, timestamp]
            searchLogs.appendRow(ar)
        }
    } catch (e) {
        errorLogs.appendRow([e])
    }
    return ContentService.createTextOutput('OK').setMimeType(
        ContentService.MimeType.TEXT
    )
}

function setStatus(slackBotToken, channel_id, thread_ts, status) {
    UrlFetchApp.fetch('https://api.slack.com/api/assistant.threads.setStatus', {
        method: 'post',
        headers: {
            Authorization: 'Bearer ' + slackBotToken,
            'Content-Type': 'application/json',
        },
        payload: JSON.stringify({
            channel_id: channel_id,
            thread_ts: thread_ts,
            status: status,
        }),
    })
}

function postToSlackWithBlockKit(slackBotToken, messageBlocks, chid, ch_ts) {
    var url = 'https://slack.com/api/chat.postMessage'
    var channelID = chid
    var ts = ch_ts
    UrlFetchApp.fetch(url, {
        headers: {
            Authorization: 'Bearer ' + slackBotToken,
            'Content-Type': 'application/json',
        },
        method: 'post',
        payload: JSON.stringify({
            thread_ts: ts,
            channel: channelID,
            unfurl_links: true,
            attachments: JSON.stringify(messageBlocks),
        }),
    })
}

function wpSearch(query) {
    try {
        // 検索ワードがない場合はエラーを返す
        if (!query) {
            return [
                {
                    type: 'header',
                    text: {
                        type: 'plain_text',
                        text: ':warning: 検索ワードを認識できません',
                        emoji: true,
                    },
                },
            ]
        }

        // 環境変数を取得
        let baseUrl =
            PropertiesService.getScriptProperties().getProperty('WP_BASE_URL')
        let wpUser =
            PropertiesService.getScriptProperties().getProperty('WP_USERNAME')
        let wpPass =
            PropertiesService.getScriptProperties().getProperty('WP_PASSWORD')

        let url = baseUrl + '/wp-json/wp/v2/search?search='
        let auth = Utilities.base64Encode(`${wpUser}:${wpPass}`)
        let response = UrlFetchApp.fetch(url + query, {
            method: 'get',
            headers: {
                Authorization: `Basic ${auth}`,
            },
        })
        let contents = JSON.parse(response.getContentText()).map((content) => {
            return {
                title: content.title,
                url: content.url,
            }
        })
        let blockKit = createBlockKit(query, contents)
        return blockKit
    } catch (e) {
        return [
            {
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: ':warning: エラーが発生しました' + e,
                    emoji: true,
                },
            },
        ]
    }
}

// 検索結果を元にBlock Kitを生成する
function createBlockKit(query, contents) {
    let blockKit = []
    let template = JSON.parse(JSON.stringify(blockKitTemplate)) // ミューテーションを避けるためにディープコピーする
    // ヘッダーテキストにクエリを追加
    template.header.text.text = query + ' ' + template.header.text.text
    // ヘッダーをblockKitに追加
    blockKit.push(template.header)
    // 結果数をblockKitに追加
    let resultCount = JSON.parse(JSON.stringify(template.resultCount))
    resultCount.elements[1].text =
        contents.length + resultCount.elements[1].text
    blockKit.push(resultCount)
    // ディバイダーをblockKitに追加
    blockKit.push(template.divider)
    // 検索結果をblockKitに追加
    let results = JSON.parse(JSON.stringify(template.results))
    results.elements[0].elements = contents.map((content) => {
        let item = JSON.parse(JSON.stringify(template.item))
        item.elements[0].url = content.url
        item.elements[0].text = content.title
        return item
    })
    blockKit.push(results)
    return blockKit
}

// Block Kitのテンプレート
let blockKitTemplate = {
    header: {
        type: 'header',
        text: {
            type: 'plain_text',
            text: 'を含む記事の検索結果',
            emoji: true,
        },
    },
    resultCount: {
        type: 'context',
        elements: [
            {
                type: 'image',
                image_url: 'https://YOUR_LOGO_URL/logo.png',
                alt_text: 'wp-logo',
            },
            {
                type: 'mrkdwn',
                text: '件の記事が見つかりました！',
            },
        ],
    },
    divider: {
        type: 'divider',
    },
    results: {
        type: 'rich_text',
        elements: [
            {
                type: 'rich_text_list',
                style: 'bullet',
                elements: [],
            },
        ],
    },
    item: {
        type: 'rich_text_section',
        elements: [
            {
                type: 'link',
                url: 'https://example.com',
                text: 'page-title',
                style: {
                    bold: true,
                },
            },
        ],
    },
}
