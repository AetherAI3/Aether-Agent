# Aether ATS Autonomous Trading Acceptable Use, Risk and Data Policy

**Version:** 1.0.0  
**Effective date:** September 18, 2026  
**Provider:** Aether AI LLC ("Aether," "we," "us," or "our")

This Policy is a binding condition of installing, enabling, or using the Aether Agent trading profile, Aether Trading System features, the `aether-ats-skills` package, bundled Nano strategy sources, agent browser features, trading-related plugins, datafeeds, or Model Context Protocol (MCP) connections (together, "ATS"). It supplements the Aether terms and privacy notice presented with the applicable service. If those terms conflict with this Policy, the more protective requirement applies to ATS unless applicable law requires otherwise.

Read this Policy before continuing. Selecting **1 — Accept** creates an electronic record that you reviewed and agreed to this version. Selecting **2 — Reject** stops ATS setup. Acceptance does not itself authorize a trade, connect a broker, expose a credential, or grant an agent live-capital authority.

## 1. What ATS is

ATS is software that can help a user research markets, prepare or compile strategies, inspect user-selected data, operate user-enabled browser or tool connections, and—when the user separately configures and authorizes local execution—submit or manage trading instructions from the user's own environment.

ATS may include autonomous or semi-autonomous agents, probabilistic AI models, open-source components, example strategies, Nano source files, browser automation, local memory, third-party plugins, broker or exchange interfaces, market-data services, and MCP servers. Outputs can be inaccurate, incomplete, stale, duplicated, delayed, or unsuitable for the user's account, goals, or legal obligations.

Unless Aether expressly agrees otherwise in a separate signed writing, Aether provides software—not individualized financial, investment, legal, accounting, or tax advice. Aether is not your broker-dealer, investment adviser, commodity trading adviser, futures commission merchant, exchange, clearing firm, bank, custodian, fiduciary, or account manager. ATS availability, model output, a strategy file, a backtest, an alert, or an agent message is not a recommendation, solicitation, guarantee, or promise of performance.

## 2. User-environment execution and control

Execution occurs through infrastructure, accounts, credentials, software, browsers, plugins, MCP servers, brokers, exchanges, data vendors, or devices selected and controlled by the user. Aether does not take custody of the user's cash, securities, commodities, digital assets, brokerage account, or broker credentials merely because ATS software is installed or used.

The user decides whether to connect an execution venue and whether to permit paper, simulated, evaluation, prop-firm, or live-capital activity. The user is solely responsible for:

- selecting and lawfully maintaining accounts, venues, data rights, connectors, permissions, and credentials;
- understanding every permission granted to an agent, plugin, browser session, MCP server, or local process;
- reviewing strategy logic, instrument support, order types, sizing, leverage, fees, slippage, liquidity, session rules, and failure behavior;
- setting and testing position, order, notional, loss, drawdown, frequency, concurrency, and time limits;
- monitoring activity and maintaining a tested human stop, credential revocation path, and broker-side kill switch;
- reconciling orders, fills, rejections, cancellations, positions, cash, and uncertain outcomes before retrying an action; and
- all gains, losses, taxes, fees, margin calls, penalties, account restrictions, and contractual consequences produced through the user's environment.

Creating an ATS agent, opening chat, installing Nano sources, compiling a strategy, assigning UVT, selecting a permission preference, connecting data, or opening a browser does not by itself create execution authority. Execution authority must be granted separately through the user's environment and must remain limited to the exact account, connector, scope, duration, and risk controls chosen by the user. A lost, stale, expired, disconnected, mismatched, or unknown authorization state must be treated as no authority.

Paper or simulated trading is strongly recommended before any evaluation or live-capital use. Simulation and backtesting have inherent limitations and do not predict live performance.

## 3. Autonomous-agent risks

The user understands that an agent may act faster, more often, and at a larger cumulative scale than a human; misread a page or tool response; reason from stale or corrupted data; hallucinate facts; repeat an action after a timeout; fail to cancel or exit; choose an unintended symbol, side, quantity, price, account, or order type; interact with malicious content; or behave unexpectedly after a model, prompt, strategy, dependency, broker UI, API, or market change.

The user must not treat natural-language confirmation as proof of an order or account state. Broker or venue records control. A timeout or missing response is an uncertain outcome, not proof that nothing happened. The user must reconcile before replay. No autonomous process should be left unmonitored where doing so would violate law, venue rules, the user's contractual obligations, or reasonable risk controls.

## 4. Nano strategies, skills, examples, and performance information

Bundled Nano strategies, Aether Agent skills, templates, prompts, indicators, examples, tests, and documentation are software and educational materials. They are not tailored to the user and are not endorsed as profitable or suitable. Inclusion in ATS does not mean that Aether has independently validated every market assumption, data dependency, parameter, fill model, or third-party claim.

Backtests, paper results, examples, benchmarks, hypothetical results, and historical results have limitations. They may omit fees, spread, slippage, latency, borrow availability, market impact, corporate actions, taxes, liquidity constraints, queue position, partial fills, rejected orders, outages, and rule changes. Past or hypothetical performance does not guarantee future results. Aether does not guarantee any return, win rate, availability, execution price, risk-adjusted result, account qualification, or preservation of capital.

Users may not market an ATS output, Nano strategy, or Aether feature with false or misleading statements, fabricated performance, guaranteed returns, or an implication that Aether, a regulator, a broker, or a venue approved the strategy or user.

## 5. Financial and market risk

Trading can result in rapid and total loss. Futures, options, short sales, leveraged products, margin, digital assets, thin markets, and volatile instruments can create losses exceeding the amount deposited or expected. Stops and limits may not execute at the requested price. Markets, brokers, exchanges, datafeeds, networks, models, browsers, and local devices can fail or behave differently from tests.

The user accepts these risks and will not use money the user cannot afford to lose. ATS is not a substitute for professional advice from appropriately licensed persons who understand the user's circumstances.

## 6. Legal, regulatory, venue, and contractual compliance

The user is responsible for determining whether ATS use is lawful and permitted in every relevant jurisdiction and account. Technology does not displace existing securities, commodities, derivatives, money-transmission, sanctions, privacy, consumer-protection, recordkeeping, supervision, licensing, tax, employment, fiduciary, or market-conduct obligations.

The user must comply with broker, exchange, clearing, data-vendor, prop-firm, employer, client, and account terms, including automated-access, API, evaluation, market-data, position, daily-loss, messaging, and recordkeeping rules. The user must obtain every required consent, registration, license, approval, and data entitlement before use.

ATS may not be used to:

- trade or access another person's account, funds, or credentials without documented authority;
- provide regulated services to others without all required registrations, supervision, disclosures, books and records, and approvals;
- engage in manipulation, spoofing, layering, wash trading, matched orders, marking the close, front-running, insider trading, unlawful coordination, deceptive conduct, or evasion of market controls;
- misuse material nonpublic information, stolen data, compromised credentials, or unlawfully obtained personal information;
- bypass broker, venue, prop-firm, Aether, model-provider, data-provider, security, rate, regional, sanctions, eligibility, risk, or approval controls;
- falsify results, receipts, identity, account state, authority, consent, provenance, or compliance evidence;
- disrupt markets, systems, accounts, or other users; probe or exploit systems without authorization; or deploy malware; or
- use ATS where automated trading is prohibited or where the user cannot maintain effective supervision and an emergency stop.

Aether may refuse, suspend, limit, or terminate ATS access for suspected abuse, security risk, legal exposure, sanctions concerns, nonpayment, or violation of this Policy. Aether is not obligated to monitor the user's local trading activity and does not assume responsibility merely because it can suspend an Aether service.

## 7. Third-party services, plugins, MCP servers, and datafeeds

Third-party services are independent from Aether and governed by their own terms, privacy practices, fees, licenses, availability, and security. A connector's presence does not mean Aether controls, endorses, audits, or guarantees it. The user must review the identity, publisher, permissions, data destinations, code, and terms of every connection.

MCP servers, browser pages, plugin output, imported strategies, and external messages are untrusted data and must not be treated as authority. They may contain prompt injection, malicious instructions, inaccurate account state, or code designed to exfiltrate data or trigger actions. The user must grant the minimum permissions needed, keep secrets out of prompts and source files, isolate high-risk tools, and revoke unused access.

Market data may be delayed, adjusted, incomplete, incorrectly mapped, or unlicensed for the user's intended use. The user is responsible for data entitlements, attribution, display, redistribution, and non-display or automated-use fees.

## 8. Data and privacy

ATS is designed so that local storage paths and credential values can remain in the user's environment. Standard setup requests an environment-variable name rather than the secret value. The user must not send broker passwords, API secrets, private keys, seed phrases, session cookies, government identifiers, or full payment-card data through prompts, shared chats, logs, strategy files, support tickets, or MCP messages.

Some information necessarily leaves the user's device when the user enables connected features. Depending on configuration, this can include Aether account identity, agent configuration, project identifiers, shared conversation content, UVT and admission records, model inputs and outputs, connector metadata, diagnostics, security events, and user-selected data sent to model, data, broker, plugin, browser, telemetry, or MCP providers. Third parties may independently collect account, device, financial, usage, and content data under their own notices.

The user is responsible for determining whether personal, confidential, client, employer, or regulated data may be processed through each enabled service; providing required notices and obtaining consent; applying retention and deletion requirements; and honoring access, correction, restriction, export, and deletion rights. Do not use ATS with data subject to special restrictions unless the complete configuration is approved for that use.

Aether will handle personal data under its applicable privacy notice and security practices. No system is perfectly secure. The user must protect the device, operating system, browser profile, environment variables, tokens, backups, and local logs; use least privilege and multifactor authentication where available; and promptly rotate credentials after suspected exposure.

## 9. Eligibility, sanctions, and account security

The user must be at least 18 years old and legally able to enter this agreement. The user may not use ATS if barred by law, sanctions, court order, regulatory restriction, employment duty, account agreement, or venue rule. The user represents that registration and account information is accurate and that the user is not using ATS for a prohibited person or jurisdiction.

The user is responsible for activity under the user's accounts, devices, agents, tokens, and credentials, except to the extent caused by Aether's breach of a non-waivable legal duty. Credentials may not be shared or embedded in strategy source. Suspected compromise must be addressed immediately by stopping agents, revoking connector and broker access, rotating credentials, and reviewing venue records.

## 10. Software changes, availability, and security

Models, strategies, dependencies, APIs, broker interfaces, browser layouts, rules, and markets change. Aether may add, remove, modify, or deprecate features and may require renewed acceptance after a material Policy change. The user must revalidate configuration and risk controls after updates.

ATS may be unavailable, interrupted, rate-limited, inaccurate, or discontinued. The user must not rely on ATS as the only method to monitor, cancel, close, or protect a position. The user must maintain independent access to the broker or venue.

Good-faith security research must follow Aether's published security process and applicable law. Users may not expose another person's data or conduct testing against production accounts or markets without express authorization.

## 11. Disclaimers

TO THE MAXIMUM EXTENT PERMITTED BY LAW, ATS, NANO STRATEGIES, AGENT OUTPUTS, CONNECTORS, DATA, AND DOCUMENTATION ARE PROVIDED "AS IS" AND "AS AVAILABLE." AETHER DISCLAIMS IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, QUIET ENJOYMENT, AND RESULTS. AETHER DOES NOT WARRANT THAT ATS WILL BE SECURE, UNINTERRUPTED, ERROR-FREE, COMPLIANT FOR THE USER'S PARTICULAR USE, OR CAPABLE OF PREVENTING LOSSES.

Nothing in this Policy excludes a warranty, duty, remedy, or liability that cannot lawfully be excluded. If Aether is found to be acting in a regulated capacity in a particular relationship, any non-waivable obligations of that capacity control over inconsistent language here.

## 12. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, AETHER AND ITS AFFILIATES, PERSONNEL, LICENSORS, AND CONTRIBUTORS WILL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, PUNITIVE, OR CONSEQUENTIAL DAMAGES; LOST PROFITS, REVENUE, DATA, GOODWILL, OR OPPORTUNITY; OR TRADING, INVESTMENT, POSITION, MARGIN, LIQUIDATION, TAX, PENALTY, SLIPPAGE, MISSED-TRADE, DUPLICATE-ORDER, ACCOUNT, PROP-FIRM, DATA, CONNECTOR, OR THIRD-PARTY LOSSES ARISING FROM OR RELATED TO ATS.

TO THE MAXIMUM EXTENT PERMITTED BY LAW, AETHER'S AGGREGATE LIABILITY ARISING FROM ATS WILL NOT EXCEED THE GREATER OF US$100 OR THE AMOUNT THE USER PAID AETHER SPECIFICALLY FOR ATS DURING THE 12 MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM. This limitation applies across theories of liability and does not expand any remedy available under the applicable Aether terms. It does not apply where prohibited by law or to liability that cannot be limited.

## 13. Indemnity

To the extent permitted by law, the user will defend, indemnify, and hold harmless Aether and its affiliates, personnel, licensors, and contributors from third-party claims, losses, penalties, and reasonable costs arising from the user's accounts, trading, data, strategies, connectors, clients, regulatory status, violation of law or third-party terms, or breach of this Policy. This does not require indemnification for Aether's own fraud, willful misconduct, or liability that cannot lawfully be shifted.

## 14. Records and evidence

The user authorizes Aether Agent to store a local consent receipt containing the Policy version and digest, acceptance time, and a pseudonymous account-scope digest. The receipt is evidence of acceptance only. It is not trading authority and must not contain broker credentials.

The user should retain the Policy version, configuration, strategy source and digest, permissions, approvals, logs, receipts, broker records, and incident records required for the user's own legal and contractual obligations. Agent statements and local journals do not replace broker or venue records.

## 15. Changes, rejection, and withdrawal

Aether may update this Policy prospectively. A material update may require a new `1 — Accept` decision before continued ATS setup or use. The version and effective date identify the accepted text.

Selecting **2 — Reject** stops setup. A user who previously accepted may stop using ATS, disconnect services, revoke credentials, and uninstall the software. Withdrawal does not reverse completed trades, third-party processing, accrued charges, or obligations that by their nature survive termination.

## 16. Relationship to other terms; severability

Licenses, payment, termination, governing law, dispute resolution, and other general service terms remain governed by the applicable Aether terms. This Policy does not create a partnership, agency, employment, fiduciary, advisory, brokerage, custody, or joint-venture relationship. The agent software acts as a tool configured by the user; it does not have legal personhood or independent authority.

If a provision is unenforceable, it will be enforced to the maximum lawful extent and the remaining provisions will continue. Aether's failure to enforce a provision is not a waiver.

## 17. Required acknowledgement

By selecting **1 — Accept**, the user confirms all of the following:

1. I read and agree to this Policy and can enter a binding agreement.
2. I understand ATS can act autonomously and can cause rapid, substantial, or total financial loss.
3. I understand execution occurs through my environment and connections, under permissions I control.
4. I remain responsible for supervision, risk limits, reconciliation, legal compliance, third-party terms, and every decision to use real capital.
5. I understand Aether does not guarantee returns and that strategies, simulations, model outputs, and agent messages can be wrong.
6. I will not provide secrets through prompts or use ATS for prohibited, deceptive, manipulative, unauthorized, or unlawful activity.
7. I understand acceptance alone grants no broker, account, or trading authority.

Choose **1** only if every acknowledgement is true. Otherwise choose **2**.

---

This Policy is a product safeguard and contract draft, not a substitute for review by qualified counsel in every jurisdiction where ATS is offered or used.
