<script lang="ts">
  // Credits API not yet implemented — enhanced placeholder
</script>

<div class="credits">
  <h1>Credits & Wallet</h1>

  <div class="balance-card-border">
    <div class="balance-card">
      <span class="label">Current Balance</span>
      <span class="amount">--</span>
      <span class="sublabel">Credit ledger not yet available</span>
    </div>
  </div>

  <div class="explain-row">
    <div class="explain-card">
      <div class="explain-icon">+</div>
      <h3>Earn</h3>
      <p>Complete inference tasks for other nodes to earn credits</p>
    </div>
    <div class="explain-card">
      <div class="explain-icon">&minus;</div>
      <h3>Spend</h3>
      <p>Submit your own code completion tasks using earned credits</p>
    </div>
    <div class="explain-card">
      <div class="explain-icon">&equiv;</div>
      <h3>Track</h3>
      <p>View transaction history, contribution reports, and payout events</p>
    </div>
  </div>

  <div class="coming-soon">
    <h2>Coming Soon</h2>
    <ul>
      <li>Credit balance &amp; history</li>
      <li>Contribution reports (CPU/GPU seconds)</li>
      <li>Wallet integration (Lightning/on-chain)</li>
      <li>Issuance epoch tracking</li>
    </ul>
  </div>
</div>

<style>
  .credits {
    padding: 1.5rem;
    max-width: 860px;
  }

  h1 {
    margin: 0 0 1.5rem;
    font-size: 1.4rem;
  }

  /* Gradient border wrapper */
  .balance-card-border {
    background: linear-gradient(135deg, var(--accent, #3b82f6), var(--green, #4ade80), var(--accent, #3b82f6));
    padding: 1px;
    border-radius: 14px;
    margin-bottom: 2rem;
  }

  .balance-card {
    background: var(--bg-card, #1a1a2e);
    padding: 2.5rem 2rem;
    border-radius: 13px;
    text-align: center;
  }

  .balance-card .label {
    display: block;
    color: var(--text-muted, #94a3b8);
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 0.75rem;
  }

  .amount {
    display: block;
    font-size: 3rem;
    font-weight: 700;
    opacity: 0.25;
    letter-spacing: 0.1em;
  }

  .sublabel {
    display: block;
    margin-top: 0.75rem;
    font-size: 0.8rem;
    color: var(--text-muted, #94a3b8);
    opacity: 0.7;
  }

  /* Explanation cards row */
  .explain-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
    margin-bottom: 2rem;
  }

  .explain-card {
    background: var(--bg-card, #1a1a2e);
    border: 1px solid var(--border, #1e1e3f);
    border-radius: 10px;
    padding: 1.4rem 1.2rem;
    text-align: center;
  }

  .explain-icon {
    width: 40px;
    height: 40px;
    margin: 0 auto 0.75rem;
    border-radius: 50%;
    background: rgba(59, 130, 246, 0.12);
    color: var(--accent, #3b82f6);
    font-size: 1.3rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .explain-card h3 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
  }

  .explain-card p {
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-muted, #94a3b8);
    line-height: 1.5;
  }

  /* Coming soon section */
  .coming-soon {
    background: var(--bg-card, #1a1a2e);
    border: 1px solid var(--border, #1e1e3f);
    border-radius: 10px;
    padding: 1.4rem 1.6rem;
  }

  .coming-soon h2 {
    margin: 0 0 0.8rem;
    font-size: 1rem;
    color: var(--text-muted, #94a3b8);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }

  .coming-soon ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .coming-soon li {
    padding: 0.5rem 0;
    font-size: 0.88rem;
    color: var(--text-muted, #94a3b8);
    border-bottom: 1px solid var(--border, #1e1e3f);
  }

  .coming-soon li:last-child {
    border-bottom: none;
  }

  .coming-soon li::before {
    content: "\25CB";
    margin-right: 0.6rem;
    opacity: 0.5;
  }

  @media (max-width: 640px) {
    .explain-row {
      grid-template-columns: 1fr;
    }
  }
</style>
