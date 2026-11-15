import { describe, expect, it } from "vitest";
import { payoutDebitTxId, payoutRefundTxId, payoutFeeExcessTxId } from "../../src/economy/payouts.js";

describe("payout transaction ID functions", () => {
  describe("payoutDebitTxId", () => {
    it("should return the correct prefix plus the payout id", () => {
      const payoutId = "test-payout-123";
      const result = payoutDebitTxId(payoutId);
      expect(result).toBe(`payout:${payoutId}`);
    });

    it("should handle empty payout id", () => {
      const payoutId = "";
      const result = payoutDebitTxId(payoutId);
      expect(result).toBe(`payout:${payoutId}`);
    });

    it("should handle special characters in payout id", () => {
      const payoutId = "test-payout-123_abc.def";
      const result = payoutDebitTxId(payoutId);
      expect(result).toBe(`payout:${payoutId}`);
    });
  });

  describe("payoutRefundTxId", () => {
    it("should return the correct prefix plus the payout id", () => {
      const payoutId = "test-payout-123";
      const result = payoutRefundTxId(payoutId);
      expect(result).toBe(`payout_refund:${payoutId}`);
    });

    it("should handle empty payout id", () => {
      const payoutId = "";
      const result = payoutRefundTxId(payoutId);
      expect(result).toBe(`payout_refund:${payoutId}`);
    });

    it("should handle special characters in payout id", () => {
      const payoutId = "test-payout-123_abc.def";
      const result = payoutRefundTxId(payoutId);
      expect(result).toBe(`payout_refund:${payoutId}`);
    });
  });

  describe("payoutFeeExcessTxId", () => {
    it("should return the correct prefix plus the payout id", () => {
      const payoutId = "test-payout-123";
      const result = payoutFeeExcessTxId(payoutId);
      expect(result).toBe(`payout_fee_excess:${payoutId}`);
    });

    it("should handle empty payout id", () => {
      const payoutId = "";
      const result = payoutFeeExcessTxId(payoutId);
      expect(result).toBe(`payout_fee_excess:${payoutId}`);
    });

    it("should handle special characters in payout id", () => {
      const payoutId = "test-payout-123_abc.def";
      const result = payoutFeeExcessTxId(payoutId);
      expect(result).toBe(`payout_fee_excess:${payoutId}`);
    });
  });

  describe("all three functions together", () => {
    it("should return different IDs for the same payout id", () => {
      const payoutId = "test-payout-123";
      const debitId = payoutDebitTxId(payoutId);
      const refundId = payoutRefundTxId(payoutId);
      const feeExcessId = payoutFeeExcessTxId(payoutId);

      expect(debitId).toBe(`payout:${payoutId}`);
      expect(refundId).toBe(`payout_refund:${payoutId}`);
      expect(feeExcessId).toBe(`payout_fee_excess:${payoutId}`);

      // All three should be different
      expect(debitId).not.toBe(refundId);
      expect(debitId).not.toBe(feeExcessId);
      expect(refundId).not.toBe(feeExcessId);
    });

    it("should return same output for same input", () => {
      const payoutId = "test-payout-123";
      
      const debit1 = payoutDebitTxId(payoutId);
      const debit2 = payoutDebitTxId(payoutId);
      expect(debit1).toBe(debit2);

      const refund1 = payoutRefundTxId(payoutId);
      const refund2 = payoutRefundTxId(payoutId);
      expect(refund1).toBe(refund2);

      const feeExcess1 = payoutFeeExcessTxId(payoutId);
      const feeExcess2 = payoutFeeExcessTxId(payoutId);
      expect(feeExcess1).toBe(feeExcess2);
    });

    it("should return different IDs for different payout ids", () => {
      const payoutId1 = "test-payout-123";
      const payoutId2 = "test-payout-456";
      
      const debit1 = payoutDebitTxId(payoutId1);
      const debit2 = payoutDebitTxId(payoutId2);
      expect(debit1).not.toBe(debit2);

      const refund1 = payoutRefundTxId(payoutId1);
      const refund2 = payoutRefundTxId(payoutId2);
      expect(refund1).not.toBe(refund2);

      const feeExcess1 = payoutFeeExcessTxId(payoutId1);
      const feeExcess2 = payoutFeeExcessTxId(payoutId2);
      expect(feeExcess1).not.toBe(feeExcess2);
    });
  });
});