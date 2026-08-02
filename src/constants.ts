

/**Shared terminal and UI constants for pchain extensions. */


// ========================================
// SGR

/** Reset all SGR attributes (color, bold, reverse, etc.). */
export const SGR_RESET = "\x1b[0m";

/** Set reverse video on (highlight/selection). */
export const SGR_REVERSE_ON = "\x1b[7m";

/** Set reverse video off. */
export const SGR_REVERSE_OFF = "\x1b[27m";
