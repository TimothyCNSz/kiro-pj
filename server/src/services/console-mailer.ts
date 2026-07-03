// ConsoleMailer —— 本地开发用的邮件降级实现（不发真实邮件）。
//
// 生产用 SesMailer 经 Amazon SES 发送验证邮件；本地没有 SES 凭证与已验证发件身份，
// 直接发信会失败，导致注册后拿不到验证链接、账号无法激活登录。本实现把邮件内容
// （尤其是含 token 的验证链接/验证码）打印到后端控制台，便于本地完成
// 注册 → 邮箱验证 → 登录 的完整流程。
//
// 仅用于本地验证。通过环境变量 `MAILER=console` 启用（见 routes/auth.ts）。

import type { EmailMessage, Mailer } from './ses-mailer'

/** 把邮件内容打印到控制台的 Mailer 实现（本地开发用）。 */
export class ConsoleMailer implements Mailer {
  async send(message: EmailMessage): Promise<void> {
    console.log('\n========== [ConsoleMailer] 模拟发送邮件（本地开发） ==========')
    console.log(`收件人 (to):   ${message.to}`)
    console.log(`主题 (subject): ${message.subject}`)
    console.log('正文 (text):')
    console.log(message.text)
    console.log('提示：复制上面的验证链接/验证码，在前端验证页或调用 /api/auth/verify-email 完成激活。')
    console.log('================================================================\n')
  }
}
