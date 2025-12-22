declare module 'web-push' {
  interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }

  interface PushSubscription {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  }

  interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }

  interface WebPushError extends Error {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    endpoint: string;
  }

  function generateVAPIDKeys(): VapidKeys;
  function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  function sendNotification(subscription: PushSubscription, payload: string | Buffer, options?: any): Promise<SendResult>;

  export { generateVAPIDKeys, setVapidDetails, sendNotification, VapidKeys, PushSubscription, SendResult, WebPushError };
  export default { generateVAPIDKeys, setVapidDetails, sendNotification };
}
