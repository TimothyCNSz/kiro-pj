// SES mailer (需求 1.4)。
//
// A thin wrapper around Amazon SES `SendEmail` (AWS SDK v3) exposed behind the
// small `Mailer` interface so that services depend on the abstraction rather
// than the concrete SES client. Tests inject a fake/spy implementing `Mailer`
// and never touch real SES (see design "SES 集成与容错要点").
//
// The from-identity is a SES-verified sender (company domain + DKIM). It is
// resolved from `SES_FROM_ADDRESS` unless explicitly provided, and only the
// send path requires it — merely constructing the mailer stays side-effect
// free so importing this module never opens AWS clients in tests.
//
// Requirements: 1.4.

import { SendEmailCommand, SESClient, type Body } from '@aws-sdk/client-ses'

/** 一封待发送邮件（发件人由 Mailer 实现统一注入）。 */
export interface EmailMessage {
  /** 收件地址。 */
  to: string
  /** 邮件主题。 */
  subject: string
  /** 纯文本正文（必填，保证纯文本客户端可读）。 */
  text: string
  /** 可选 HTML 正文。 */
  html?: string
}

/**
 * 发信抽象。业务服务只依赖此接口，便于在测试中注入替身（fake/spy），
 * 从而不触达真实 SES。
 */
export interface Mailer {
  send(message: EmailMessage): Promise<void>
}

/** `SesMailer` 构造选项。 */
export interface SesMailerOptions {
  /** 可注入的 SES 客户端（测试可传替身；缺省按 region 新建）。 */
  client?: SESClient
  /** 经 SES 验证的发件地址；缺省读取 `SES_FROM_ADDRESS`。 */
  fromAddress?: string
  /** SES 客户端 region；缺省读取 `AWS_REGION`。 */
  region?: string
}

const UTF8 = 'UTF-8'

/**
 * 基于 Amazon SES `SendEmail` 的 `Mailer` 实现。
 *
 * 构造函数不产生副作用（不校验/不连接）；`fromAddress` 缺失只在真正 `send`
 * 时才报错，使单元测试可在无 AWS 环境下导入依赖此类的代码。
 */
export class SesMailer implements Mailer {
  private readonly client: SESClient
  private readonly fromAddress?: string

  constructor(options: SesMailerOptions = {}) {
    this.fromAddress = options.fromAddress ?? process.env.SES_FROM_ADDRESS
    this.client =
      options.client ??
      new SESClient(options.region ? { region: options.region } : {})
  }

  async send(message: EmailMessage): Promise<void> {
    if (!this.fromAddress) {
      throw new Error(
        'SES_FROM_ADDRESS is not set. A verified SES sender identity is required to send email.',
      )
    }

    const body: Body = {
      Text: { Data: message.text, Charset: UTF8 },
    }
    if (message.html !== undefined) {
      body.Html = { Data: message.html, Charset: UTF8 }
    }

    await this.client.send(
      new SendEmailCommand({
        Source: this.fromAddress,
        Destination: { ToAddresses: [message.to] },
        Message: {
          Subject: { Data: message.subject, Charset: UTF8 },
          Body: body,
        },
      }),
    )
  }
}
