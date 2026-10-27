// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

//! Per-launch local auth tokens (#6): 32 bytes from the OS CSPRNG, hex-encoded.

/// Generate a 64-character lowercase hex token from 32 bytes of OS randomness.
pub fn generate_local_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("OS CSPRNG unavailable");
    hex::encode(buf)
}

#[cfg(test)]
mod tests {
    use super::generate_local_token;

    #[test]
    fn token_is_64_lowercase_hex_chars() {
        let t = generate_local_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
    }

    #[test]
    fn tokens_differ() {
        assert_ne!(generate_local_token(), generate_local_token());
    }
}
