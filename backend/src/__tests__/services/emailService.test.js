jest.mock('nodemailer', () => {
  const sendMailMock = jest.fn().mockResolvedValue({
    accepted: ['test@example.com'],
    messageId: 'mock-id-123'
  });

  return {
    createTransport: jest.fn(() => ({
      sendMail: sendMailMock
    })),
    __sendMailMock: sendMailMock
  };
});

const nodemailer = require('nodemailer');
const { sendEmail, createTransporter } = require('../../services/emailService');

describe('EmailService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('createTransporter', () => {
    test('should return null when SMTP is not configured', () => {
      delete process.env.SMTP_HOST;
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;
      expect(createTransporter()).toBeNull();
    });

    test('should create transporter when SMTP is configured', () => {
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_PORT = '587';
      process.env.SMTP_USER = 'user@example.com';
      process.env.SMTP_PASS = 'password';

      const transporter = createTransporter();
      expect(transporter).not.toBeNull();
      expect(nodemailer.createTransport).toHaveBeenCalledWith({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        auth: { user: 'user@example.com', pass: 'password' }
      });
    });

    test('should use secure connection for port 465', () => {
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_PORT = '465';
      process.env.SMTP_USER = 'user@example.com';
      process.env.SMTP_PASS = 'password';

      createTransporter();
      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ secure: true })
      );
    });
  });

  describe('sendEmail', () => {
    test('should log to console when SMTP is not configured', async () => {
      delete process.env.SMTP_HOST;
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const result = await sendEmail({
        to: 'test@example.com',
        subject: 'Test',
        html: '<p>Test</p>'
      });

      expect(result.accepted).toEqual(['test@example.com']);
      expect(result.messageId).toBe('console-fallback');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('SMTP not configured')
      );

      consoleSpy.mockRestore();
    });

    test('should send email when SMTP is configured', async () => {
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_USER = 'sender@example.com';
      process.env.SMTP_PASS = 'password';
      process.env.SMTP_FROM = 'noreply@example.com';

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const result = await sendEmail({
        to: 'test@example.com',
        subject: 'Test Subject',
        html: '<p>Test body</p>'
      });

      expect(result.messageId).toBe('mock-id-123');
      expect(nodemailer.__sendMailMock).toHaveBeenCalledWith({
        from: 'noreply@example.com',
        to: 'test@example.com',
        subject: 'Test Subject',
        html: '<p>Test body</p>'
      });

      consoleSpy.mockRestore();
    });
  });
});
