/**
 * Stripe Webhook 컨트롤러
 */

import { Request, Response } from 'express';
import Stripe from 'stripe';
import { stripeService } from '../services/stripe.service';
import { subscriptionService } from '../services/subscription.service';
import prisma from '../config/database';

/**
 * Stripe Webhook 처리
 */
export const handleStripeWebhook = async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'] as string;

  if (!signature) {
    console.error('[Webhook] Missing stripe-signature header');
    return res.status(400).send('Missing stripe-signature header');
  }

  let event: Stripe.Event;

  try {
    event = stripeService.constructWebhookEvent(req.body, signature);
  } catch (err) {
    console.error('[Webhook] Signature verification failed:', err);
    return res.status(400).send(`Webhook Error: ${(err as Error).message}`);
  }

  console.log(`[Webhook] Received event: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutComplete(session);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdate(subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(subscription);
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        console.log(`[Webhook] Invoice paid: ${invoice.id}`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await handlePaymentFailed(invoice);
        break;
      }

      default:
        console.log(`[Webhook] Unhandled event type: ${event.type}`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error(`[Webhook] Error processing ${event.type}:`, error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
};

/**
 * Checkout 완료 처리
 */
async function handleCheckoutComplete(session: Stripe.Checkout.Session) {
  const userId = parseInt(session.metadata?.userId || '0', 10);

  if (!userId) {
    console.error('[Webhook] No userId in checkout session metadata');
    return;
  }

  console.log(`[Webhook] Checkout completed for user ${userId}`);

  // 구독 정보는 customer.subscription.created 이벤트에서 처리됨
}

/**
 * 구독 생성/업데이트 처리
 */
async function handleSubscriptionUpdate(stripeSubscription: Stripe.Subscription) {
  const customerId = stripeSubscription.customer as string;

  // Customer ID로 사용자 조회
  const subscription = await prisma.subscription.findUnique({
    where: { stripeCustomerId: customerId },
  });

  if (!subscription) {
    console.error(`[Webhook] No subscription found for customer ${customerId}`);
    return;
  }

  console.log(`[Webhook] Updating subscription for user ${subscription.userId}`);

  // 구독 상태 동기화
  await subscriptionService.syncFromStripe(subscription.userId, {
    id: stripeSubscription.id,
    status: stripeSubscription.status,
    current_period_start: (stripeSubscription as any).current_period_start,
    current_period_end: (stripeSubscription as any).current_period_end,
    cancel_at_period_end: (stripeSubscription as any).cancel_at_period_end,
    items: stripeSubscription.items,
  });

  console.log(`[Webhook] Subscription updated for user ${subscription.userId}`);
}

/**
 * 구독 삭제 처리
 */
async function handleSubscriptionDeleted(stripeSubscription: Stripe.Subscription) {
  const customerId = stripeSubscription.customer as string;

  // Customer ID로 사용자 조회
  const subscription = await prisma.subscription.findUnique({
    where: { stripeCustomerId: customerId },
  });

  if (!subscription) {
    console.error(`[Webhook] No subscription found for customer ${customerId}`);
    return;
  }

  console.log(`[Webhook] Subscription deleted for user ${subscription.userId}`);

  // Free 플랜으로 복귀
  await subscriptionService.downgradeToFree(subscription.userId);

  console.log(`[Webhook] User ${subscription.userId} downgraded to free plan`);
}

/**
 * 결제 실패 처리
 */
async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;

  // Customer ID로 사용자 조회
  const subscription = await prisma.subscription.findUnique({
    where: { stripeCustomerId: customerId },
  });

  if (!subscription) {
    console.error(`[Webhook] No subscription found for customer ${customerId}`);
    return;
  }

  console.log(`[Webhook] Payment failed for user ${subscription.userId}`);

  // 상태를 past_due로 변경
  await prisma.subscription.update({
    where: { userId: subscription.userId },
    data: { status: 'past_due' },
  });

  // TODO: 사용자에게 결제 실패 알림 발송
}
