/**
 * Email Service
 * Gmail SMTP를 사용한 이메일 발송 서비스
 */

import nodemailer from 'nodemailer';

// Gmail SMTP 설정
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD, // Gmail 앱 비밀번호
  },
});

export class EmailService {
  /**
   * 비밀번호 재설정 이메일 발송
   */
  static async sendPasswordResetEmail(
    email: string,
    resetLink: string,
    userName?: string
  ): Promise<boolean> {
    try {
      const mailOptions = {
        from: `"그리드 매매" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: '[그리드 매매] 비밀번호 재설정',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
              .header h1 { color: white; margin: 0; font-size: 24px; }
              .content { background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px; }
              .button { display: inline-block; background: #667eea; color: white !important; padding: 14px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 20px 0; }
              .button:hover { background: #5a6fd6; }
              .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
              .warning { background: #fff3cd; border: 1px solid #ffc107; padding: 12px; border-radius: 6px; margin-top: 20px; font-size: 13px; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>비밀번호 재설정</h1>
              </div>
              <div class="content">
                <p>안녕하세요${userName ? ` ${userName}님` : ''},</p>
                <p>비밀번호 재설정을 요청하셨습니다.</p>
                <p>아래 버튼을 클릭하여 새 비밀번호를 설정해주세요.</p>

                <div style="text-align: center;">
                  <a href="${resetLink}" class="button">비밀번호 재설정</a>
                </div>

                <p>또는 아래 링크를 브라우저에 직접 입력하세요:</p>
                <p style="word-break: break-all; color: #666; font-size: 13px;">
                  ${resetLink}
                </p>

                <div class="warning">
                  <strong>주의:</strong> 이 링크는 1시간 동안만 유효합니다.
                  본인이 요청하지 않은 경우, 이 이메일을 무시하세요.
                </div>
              </div>
              <div class="footer">
                <p>이 이메일은 그리드 매매 서비스에서 자동으로 발송되었습니다.</p>
                <p>&copy; ${new Date().getFullYear()} 그리드 매매. All rights reserved.</p>
              </div>
            </div>
          </body>
          </html>
        `,
      };

      await transporter.sendMail(mailOptions);
      console.log(`[EmailService] Password reset email sent to ${email}`);
      return true;
    } catch (error: any) {
      console.error(`[EmailService] Failed to send email:`, error.message);
      return false;
    }
  }

  /**
   * 이메일 발송 가능 여부 확인
   */
  static isConfigured(): boolean {
    return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
  }
}
