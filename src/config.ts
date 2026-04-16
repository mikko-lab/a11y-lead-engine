// Scoring gate -raja-arvot
// score < SCORE_MIN          → liian rikki, ohitetaan
// score >= QUALIFIED_THRESHOLD + email → QUALIFIED → sähköposti lähtee
export const SCORE_MIN           = 40
export const QUALIFIED_THRESHOLD = 70
