import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse,
  WebAuthnCredential,
} from '@simplewebauthn/server';

export interface StoredCredentialDescriptor {
  id: string;
  transports: string[];
}

export type RegistrationOptions = Omit<PublicKeyCredentialCreationOptionsJSON, 'excludeCredentials'> & {
  excludeCredentials: (StoredCredentialDescriptor & { type: 'public-key' })[];
};

export type AuthenticationOptions = Omit<PublicKeyCredentialRequestOptionsJSON, 'allowCredentials'> & {
  allowCredentials: (StoredCredentialDescriptor & { type: 'public-key' })[];
};

type RegistrationInfo = Extract<VerifiedRegistrationResponse, { verified: true }>['registrationInfo'];
export type RegistrationVerification = { verified: false; registrationInfo?: never } | {
  verified: true;
  registrationInfo: Omit<RegistrationInfo, 'credential'> & {
    credential: Omit<WebAuthnCredential, 'transports'> & { transports?: unknown };
  };
};

declare module '@simplewebauthn/server' {
  function generateRegistrationOptions(options: {
    rpName: string;
    rpID: string;
    userID: Uint8Array<ArrayBuffer>;
    userName: string;
    userDisplayName: string;
    attestationType: 'none';
    excludeCredentials: StoredCredentialDescriptor[];
    authenticatorSelection: { residentKey: 'required'; userVerification: 'required' };
  }): Promise<RegistrationOptions>;

  function generateAuthenticationOptions(options: {
    rpID: string;
    userVerification: 'required';
    allowCredentials: StoredCredentialDescriptor[];
  }): Promise<AuthenticationOptions>;

  function verifyRegistrationResponse(options: {
    response: unknown;
    expectedChallenge: string;
    expectedOrigin: string[];
    expectedRPID: string[];
    requireUserVerification: true;
  }): Promise<RegistrationVerification>;

  function verifyAuthenticationResponse(options: {
    response: unknown;
    expectedChallenge: string;
    expectedOrigin: string[];
    expectedRPID: string[];
    credential: Omit<WebAuthnCredential, 'transports'> & { transports: string[] };
    requireUserVerification: true;
  }): Promise<VerifiedAuthenticationResponse>;
}
