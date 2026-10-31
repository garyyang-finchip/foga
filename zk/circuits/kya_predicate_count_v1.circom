pragma circom 2.1.6;

// FOGA predicate-pattern ZK-KYA circuit, revision 1: `kya-predicate-count-v1`.
//
// Statement proved (the SUBJECT is public; the records and their source are not):
//   "Among at most N task-completion records signed by one source whose key is a member of the source set
//    committed to by `sourceSetRoot`, at least K concern `subjectKey`, carry status Accepted (1) and a
//    timestamp inside [t0, t1]; the records are distinct. result = 1 when the count reaches K. My nullifier
//    for (schemeId, admissionDomain, epoch, challenge) is Poseidon(secret, schemeId, admissionDomain, epoch,
//    challenge)."
//
// This is the predicate pattern of ZK-KYA (ERC-8419 section 5): the scheme is the decision rule, and the
// prover evaluates it over data authenticated by its source. The chain learns the subject, the rule's
// parameters (window, K, source set) and the result bit; never which records, how many, or their content.
// It proves a fact about a range of records, not that the agent is trustworthy.
//
// Conventions shared with the upstream `kya_public_v1` circuit: 256-bit values travel as (hi128, lo128);
// `schemeId` and `admissionDomain` are fed by the on-chain adapter from its own arguments, never chosen by
// the prover; `epoch` is enforced by the adapter against block time within a grace window.
//
// Public signals (snarkjs order: outputs first, then public inputs in declaration order):
//   [0] nullifierHi  (output)   [1] nullifierLo (output)   [2] result (output)
//   [3] subjectKeyHi  [4] subjectKeyLo  [5] challengeHi  [6] challengeLo
//   [7] t0  [8] t1  [9] k  [10] sourceSetRootHi  [11] sourceSetRootLo
//   [12] schemeIdHi  [13] schemeIdLo  [14] epoch  [15] admissionDomainHi  [16] admissionDomainLo
//
// The committed build instantiates N = 8 record slots and a source set of depth 16 (about 87k constraints,
// powers of tau 2^17); N and the depth are template parameters.
//
// A record is (subjectKeyHi, subjectKeyLo, taskRef, status, timestamp) with taskRef a 128-bit identifier of
// the completion (the source's own hash of chain, task contract, token and submission); the source signs
// Poseidon(5) of those fields with EdDSA over Baby Jubjub. Slots are filled from index 0 without gaps;
// present records carry strictly increasing taskRefs, so no record counts twice.

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/eddsaposeidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/mux1.circom";

template Split128() {
    signal input in;
    signal output hi;
    signal output lo;
    component n2b = Num2Bits_strict();
    n2b.in <== in;
    component loB = Bits2Num(128);
    component hiB = Bits2Num(126);
    for (var i = 0; i < 128; i++) loB.in[i] <== n2b.out[i];
    for (var i = 0; i < 126; i++) hiB.in[i] <== n2b.out[128 + i];
    hi <== hiB.out;
    lo <== loB.out;
}

template MerkleInclusion(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component hashers[levels];
    component mux[levels];
    signal cur[levels + 1];
    cur[0] <== leaf;
    for (var i = 0; i < levels; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== cur[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== cur[i];
        mux[i].s <== pathIndices[i];
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];
        cur[i + 1] <== hashers[i].out;
    }
    root <== cur[levels];
}

template KYAPredicateCountV1(n, depth) {
    // ---- public inputs ----
    signal input subjectKeyHi;
    signal input subjectKeyLo;
    signal input challengeHi;
    signal input challengeLo;
    signal input t0;
    signal input t1;
    signal input k;
    signal input sourceSetRootHi;
    signal input sourceSetRootLo;
    signal input schemeIdHi;
    signal input schemeIdLo;
    signal input epoch;
    signal input admissionDomainHi;
    signal input admissionDomainLo;

    // ---- private inputs ----
    signal input secret;
    signal input Ax;                      // the source's EdDSA (Baby Jubjub) public key
    signal input Ay;
    signal input pathElements[depth];     // the source's membership in the source set
    signal input pathIndices[depth];
    signal input present[n];              // 1 for a filled slot, 0 for an empty one; filled slots first
    signal input taskRef[n];              // 128-bit record identifiers, strictly increasing over filled slots
    signal input status[n];               // 1 = Accepted
    signal input timestamp[n];            // seconds, 64-bit
    signal input S[n];                    // the source's signature over each record
    signal input R8x[n];
    signal input R8y[n];

    // ---- outputs ----
    signal output nullifierHi;
    signal output nullifierLo;
    signal output result;

    // range sanity on public fields
    component skh = Num2Bits(128); skh.in <== subjectKeyHi;
    component skl = Num2Bits(128); skl.in <== subjectKeyLo;
    component chh = Num2Bits(128); chh.in <== challengeHi;
    component chl = Num2Bits(128); chl.in <== challengeLo;
    component sih = Num2Bits(128); sih.in <== schemeIdHi;
    component sil = Num2Bits(128); sil.in <== schemeIdLo;
    component adh = Num2Bits(128); adh.in <== admissionDomainHi;
    component adl = Num2Bits(128); adl.in <== admissionDomainLo;
    component t0b = Num2Bits(64);  t0b.in <== t0;
    component t1b = Num2Bits(64);  t1b.in <== t1;
    component kb  = Num2Bits(16);  kb.in <== k;
    component epb = Num2Bits(64);  epb.in <== epoch;

    // the source is a member of the source set
    component leaf = Poseidon(2);
    leaf.inputs[0] <== Ax;
    leaf.inputs[1] <== Ay;
    component inc = MerkleInclusion(depth);
    inc.leaf <== leaf.out;
    for (var i = 0; i < depth; i++) {
        inc.pathElements[i] <== pathElements[i];
        inc.pathIndices[i] <== pathIndices[i];
    }
    component rootSplit = Split128();
    rootSplit.in <== inc.root;
    rootSplit.hi === sourceSetRootHi;
    rootSplit.lo === sourceSetRootLo;

    // the records: signed by the source, about the subject, counted when Accepted inside the window
    component msg[n];
    component sig[n];
    component refBits[n];
    component tsBits[n];
    component geT0[n];
    component leT1[n];
    component isAccepted[n];
    component increasing[n];
    signal counted[n];
    signal inWindow[n];
    signal acceptedPresent[n];
    signal acc[n + 1];
    acc[0] <== 0;

    for (var i = 0; i < n; i++) {
        present[i] * (1 - present[i]) === 0;
        if (i > 0) {
            // filled slots come first: present[i] <= present[i-1]
            present[i] * (1 - present[i - 1]) === 0;
        }
        refBits[i] = Num2Bits(128); refBits[i].in <== taskRef[i];
        tsBits[i] = Num2Bits(64);   tsBits[i].in <== timestamp[i];

        msg[i] = Poseidon(5);
        msg[i].inputs[0] <== subjectKeyHi;
        msg[i].inputs[1] <== subjectKeyLo;
        msg[i].inputs[2] <== taskRef[i];
        msg[i].inputs[3] <== status[i];
        msg[i].inputs[4] <== timestamp[i];

        sig[i] = EdDSAPoseidonVerifier();
        sig[i].enabled <== present[i];
        sig[i].Ax <== Ax;
        sig[i].Ay <== Ay;
        sig[i].S <== S[i];
        sig[i].R8x <== R8x[i];
        sig[i].R8y <== R8y[i];
        sig[i].M <== msg[i].out;

        // distinct records: strictly increasing taskRef over the filled prefix
        if (i > 0) {
            increasing[i] = LessThan(128);
            increasing[i].in[0] <== taskRef[i - 1];
            increasing[i].in[1] <== taskRef[i];
            present[i] * (1 - increasing[i].out) === 0;
        }

        isAccepted[i] = IsEqual();
        isAccepted[i].in[0] <== status[i];
        isAccepted[i].in[1] <== 1;
        geT0[i] = LessEqThan(64);
        geT0[i].in[0] <== t0;
        geT0[i].in[1] <== timestamp[i];
        leT1[i] = LessEqThan(64);
        leT1[i].in[0] <== timestamp[i];
        leT1[i].in[1] <== t1;
        inWindow[i] <== geT0[i].out * leT1[i].out;
        acceptedPresent[i] <== present[i] * isAccepted[i].out;
        counted[i] <== acceptedPresent[i] * inWindow[i];
        acc[i + 1] <== acc[i] + counted[i];
    }

    // result = (count >= k)
    component reach = GreaterEqThan(16);
    reach.in[0] <== acc[n];
    reach.in[1] <== k;
    result <== reach.out;

    // nullifier scoped to (schemeId, admissionDomain, epoch, challenge)
    component nul = Poseidon(8);
    nul.inputs[0] <== secret;
    nul.inputs[1] <== schemeIdHi;
    nul.inputs[2] <== schemeIdLo;
    nul.inputs[3] <== admissionDomainHi;
    nul.inputs[4] <== admissionDomainLo;
    nul.inputs[5] <== epoch;
    nul.inputs[6] <== challengeHi;
    nul.inputs[7] <== challengeLo;
    component nulSplit = Split128();
    nulSplit.in <== nul.out;
    nullifierHi <== nulSplit.hi;
    nullifierLo <== nulSplit.lo;
}

component main { public [subjectKeyHi, subjectKeyLo, challengeHi, challengeLo, t0, t1, k, sourceSetRootHi, sourceSetRootLo, schemeIdHi, schemeIdLo, epoch, admissionDomainHi, admissionDomainLo] } = KYAPredicateCountV1(8, 16);
