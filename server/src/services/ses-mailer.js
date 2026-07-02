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
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
const UTF8 = 'UTF-8';
/**
 * 基于 Amazon SES `SendEmail` 的 `Mailer` 实现。
 *
 * 构造函数不产生副作用（不校验/不连接）；`fromAddress` 缺失只在真正 `send`
 * 时才报错，使单元测试可在无 AWS 环境下导入依赖此类的代码。
 */
export class SesMailer {
    client;
    fromAddress;
    constructor(options = {}) {
        this.fromAddress = options.fromAddress ?? process.env.SES_FROM_ADDRESS;
        this.client =
            options.client ??
                new SESClient(options.region ? { region: options.region } : {});
    }
    async send(message) {
        if (!this.fromAddress) {
            throw new Error('SES_FROM_ADDRESS is not set. A verified SES sender identity is required to send email.');
        }
        const body = {
            Text: { Data: message.text, Charset: UTF8 },
        };
        if (message.html !== undefined) {
            body.Html = { Data: message.html, Charset: UTF8 };
        }
        await this.client.send(new SendEmailCommand({
            Source: this.fromAddress,
            Destination: { ToAddresses: [message.to] },
            Message: {
                Subject: { Data: message.subject, Charset: UTF8 },
                Body: body,
            },
        }));
    }
}
