/**
 * Util methods for making Deploy message
 *
 * @packageDocumentation
 */
import { concat } from '@ethersproject/bytes';
import blake from 'blakejs';
import { Option } from './option';
import { decodeBase16, encodeBase16 } from './Conversions';
import humanizeDuration from 'humanize-duration';
import { CLTypedAndToBytesHelper, CLTypeHelper, CLValue, PublicKey, ToBytes, U32 } from './CLValue';
import {
  toBytesArrayU8,
  toBytesBytesArray,
  toBytesDeployHash,
  toBytesString,
  toBytesU64,
  toBytesVecT
} from './byterepr';
import { RuntimeArgs } from './RuntimeArgs';
import JSBI from 'jsbi';
import { Keys, URef } from './index';
import { AsymmetricKey, SignatureAlgorithm } from './Keys';
import { BigNumberish } from '@ethersproject/bignumber';
import { jsonArrayMember, jsonMember, jsonObject, TypedJSON } from 'typedjson';

const shortEnglishHumanizer = humanizeDuration.humanizer({
  spacer: '',
  serialComma: false,
  language: 'shortEn',
  languages: {
    // https://docs.rs/humantime/2.0.1/humantime/fn.parse_duration.html
    shortEn: {
      y: () => 'y',
      mo: () => 'M',
      w: () => 'w',
      d: () => 'd',
      h: () => 'h',
      m: () => 'm',
      s: () => 's',
      ms: () => 'ms'
    }
  }
});

const byteArrayJsonSerializer: (bytes: ByteArray) => string = (bytes: ByteArray) => {
  return encodeBase16(bytes);
};

const byteArrayJsonDeserializer: (str: string) => ByteArray = (str: string) => {
  return decodeBase16(str);
};

/**
 * Return a humanizer duration
 * @param ttl in milliseconds
 */
export const humanizerTTL = (ttl: number) => {
  return shortEnglishHumanizer(ttl);
};

@jsonObject
export class DeployHeader implements ToBytes {
  @jsonMember({
    serializer: (account: PublicKey) => {
      return account.toAccountHex();
    },
    deserializer: (hexStr: string) => {
      return PublicKey.fromHex(hexStr);
    }
  })
  public account: PublicKey;

  @jsonMember({ constructor: Number })
  public timestamp: number;

  @jsonMember({ constructor: Number })
  public ttl: number;

  @jsonMember({ constructor: Number, name: 'gas_price' })
  public gasPrice: number;

  @jsonMember({
    name: 'body_hash',
    serializer: byteArrayJsonSerializer,
    deserializer: byteArrayJsonDeserializer
  })
  public bodyHash: ByteArray;

  @jsonArrayMember(
    () => {
      // @ts-ignore
    }, {
      serializer: byteArrayJsonSerializer,
      deserializer: byteArrayJsonDeserializer
    })
  public dependencies: ByteArray[];

  @jsonMember({ name: 'chain_name', constructor: String })
  public chainName: string;

  /**
   * The header portion of a Deploy
   *
   * @param account The account within which the deploy will be run.
   * @param timestamp When the deploy was created.
   * @param ttl How long the deploy will stay valid.
   * @param gasPrice Price per gas unit for this deploy.
   * @param bodyHash  Hash of the Wasm code.
   * @param dependencies Other deploys that have to be run before this one.
   * @param chainName Which chain the deploy is supposed to be run on.
   */
  constructor(
    account: PublicKey,
    timestamp: number,
    ttl: number,
    gasPrice: number,
    bodyHash: ByteArray,
    dependencies: ByteArray[],
    chainName: string
  ) {
    this.account = account;
    this.timestamp = timestamp;
    this.ttl = ttl;
    this.gasPrice = gasPrice;
    this.bodyHash = bodyHash;
    this.dependencies = dependencies;
    this.chainName = chainName;
  }

  public toBytes(): ByteArray {
    return concat([
      this.account.toBytes(),
      toBytesU64(this.timestamp),
      toBytesU64(this.ttl),
      toBytesU64(this.gasPrice),
      toBytesDeployHash(this.bodyHash),
      toBytesVecT(this.dependencies.map(d => new DeployHash(d))),
      toBytesString(this.chainName)
    ]);
  }
}

/**
 * The cryptographic hash of a Deploy.
 */
class DeployHash implements ToBytes {
  constructor(private hash: ByteArray) {
  }

  public toBytes(): ByteArray {
    return toBytesDeployHash(this.hash);
  }
}

export interface DeployJson {
  session: Record<string, any>;
  approvals: { signature: string; signer: string }[];
  header: DeployHeader;
  payment: Record<string, any>;
  hash: string
}


/**
 * A struct containing a signature and the public key of the signer.
 */
@jsonObject
export class Approval {
  @jsonMember({ constructor: String })
  public signer: string;
  @jsonMember({ constructor: String })
  public signature: string;
}

export abstract class ExecutableDeployItem implements ToBytes {
  public abstract tag: number;

  public abstract args: RuntimeArgs;

  public abstract toBytes(): ByteArray;

  public getArgByName(argName: string): CLValue | undefined {
    return this.args.args[argName];
  }
}

const argsSerializer = (args: RuntimeArgs) => encodeBase16(args.toBytes());

const argsDeserializer = (byteStr: string) => {
  const argsRes = RuntimeArgs.fromBytes(decodeBase16(byteStr));
  if (argsRes.hasError()) {
    throw new Error('Failed to deserialized RuntimeArgs');
  }
  return argsRes.value;
};

@jsonObject
export class ModuleBytes extends ExecutableDeployItem {
  public tag = 0;

  @jsonMember({
    name: 'module_bytes',
    serializer: byteArrayJsonSerializer,
    deserializer: byteArrayJsonDeserializer
  })
  public moduleBytes: Uint8Array;

  @jsonMember({
      serializer: argsSerializer,
      deserializer: argsDeserializer
    }
  )
  public args: RuntimeArgs;

  constructor(moduleBytes: Uint8Array, args: RuntimeArgs) {
    super();

    this.moduleBytes = moduleBytes;
    this.args = args;
  }

  public toBytes(): ByteArray {
    return concat([
      Uint8Array.from([this.tag]),
      toBytesArrayU8(this.moduleBytes),
      toBytesArrayU8(this.args.toBytes())
    ]);
  }
}

@jsonObject
export class StoredContractByHash extends ExecutableDeployItem {
  public tag = 1;

  @jsonMember({
    serializer: byteArrayJsonSerializer,
    deserializer: byteArrayJsonDeserializer
  })
  public hash: ByteArray;

  @jsonMember({
    name: 'entry_point',
    constructor: String
  })
  public entryPoint: string;

  @jsonMember({
    serializer: argsSerializer,
    deserializer: argsDeserializer
  })
  public args: RuntimeArgs;

  constructor(
    hash: ByteArray,
    entryPoint: string,
    args: RuntimeArgs
  ) {
    super();

    this.entryPoint = entryPoint;
    this.args = args;
    this.hash = hash;
  }

  public toBytes(): ByteArray {
    return concat([
      Uint8Array.from([this.tag]),
      toBytesBytesArray(this.hash),
      toBytesString(this.entryPoint),
      toBytesArrayU8(this.args.toBytes())
    ]);
  }
}

@jsonObject
export class StoredContractByName extends ExecutableDeployItem {
  public tag = 2;

  @jsonMember({ constructor: String })
  public name: string;

  @jsonMember({
    name: 'entry_point',
    constructor: String
  })
  public entryPoint: string;

  @jsonMember({
    serializer: argsSerializer,
    deserializer: argsDeserializer
  })
  public args: RuntimeArgs;

  constructor(
    name: string,
    entryPoint: string,
    args: RuntimeArgs
  ) {
    super();

    this.name = name;
    this.entryPoint = entryPoint;
    this.args = args;
  }

  public toBytes(): ByteArray {
    return concat([
      Uint8Array.from([this.tag]),
      toBytesString(this.name),
      toBytesString(this.entryPoint),
      toBytesArrayU8(this.args.toBytes())
    ]);
  }
}

@jsonObject
export class StoredVersionedContractByName extends ExecutableDeployItem {
  public tag = 4;

  @jsonMember({ constructor: String })
  public name: string;

  @jsonMember({ constructor: Number, preserveNull: true })
  public version: number | null;

  @jsonMember({ name: 'entry_point', constructor: String })
  public entryPoint: string;

  @jsonMember({
    serializer: argsSerializer,
    deserializer: argsDeserializer
  })
  public args: RuntimeArgs;

  constructor(
    name: string,
    version: number | null,
    entryPoint: string,
    args: RuntimeArgs
  ) {
    super();
    this.name = name;
    this.version = version;
    this.entryPoint = entryPoint;
    this.args = args;
  }

  public toBytes(): ByteArray {
    let serializedVersion;
    if (this.version === null) {
      serializedVersion = new Option(null, CLTypeHelper.u32());
    } else {
      serializedVersion = new Option(new U32(this.version as number));
    }
    return concat([
      Uint8Array.from([this.tag]),
      toBytesString(this.name),
      serializedVersion.toBytes(),
      toBytesString(this.entryPoint),
      toBytesArrayU8(this.args.toBytes())
    ]);
  }
}

@jsonObject
export class StoredVersionedContractByHash extends ExecutableDeployItem {
  public tag = 3;

  @jsonMember({
    serializer: byteArrayJsonSerializer,
    deserializer: byteArrayJsonDeserializer
  })
  public hash: Uint8Array;


  @jsonMember({
    constructor: Number,
    preserveNull: true
  })
  public version: number | null;

  @jsonMember({
    name: 'entry_point',
    constructor: String
  })
  public entryPoint: string;

  @jsonMember({
    serializer: argsSerializer,
    deserializer: argsDeserializer
  })
  public args: RuntimeArgs;

  constructor(
    hash: Uint8Array,
    version: number | null,
    entryPoint: string,
    args: RuntimeArgs
  ) {
    super();
    this.hash = hash;
    this.version = version;
    this.entryPoint = entryPoint;
    this.args = args;
  }

  public toBytes(): ByteArray {
    let serializedVersion;

    if (this.version === null) {
      serializedVersion = new Option(null, CLTypeHelper.u32());
    } else {
      serializedVersion = new Option(new U32(this.version as number));
    }
    return concat([
      Uint8Array.from([this.tag]),
      toBytesBytesArray(this.hash),
      serializedVersion.toBytes(),
      toBytesString(this.entryPoint),
      toBytesArrayU8(this.args.toBytes())
    ]);
  }
}

@jsonObject
export class Transfer extends ExecutableDeployItem {
  public tag = 5;

  @jsonMember({
    serializer: argsSerializer,
    deserializer: argsDeserializer
  })
  public args: RuntimeArgs;

  /**
   * Constructor for Transfer deploy item.
   * @param amount The number of motes to transfer
   * @param target URef of the target purse or the public key of target account. You could generate this public key from accountHex by PublicKey.fromHex
   * @param sourcePurse URef of the source purse. If this is omitted, the main purse of the account creating this \
   * transfer will be used as the source purse
   * @param id user-defined transfer id
   */
  constructor(
    amount: BigNumberish,
    target: URef | PublicKey,
    sourcePurse?: URef,
    id: number | null = null
  ) {
    super();
    const runtimeArgs = RuntimeArgs.fromMap({});
    runtimeArgs.insert('amount', CLValue.u512(amount));
    if (sourcePurse) {
      runtimeArgs.insert('source', CLValue.uref(sourcePurse));
    }
    if (target instanceof URef) {
      runtimeArgs.insert('target', CLValue.uref(target));
    } else if (target instanceof PublicKey) {
      runtimeArgs.insert('target', CLValue.byteArray(target.toAccountHash()));
    } else {
      throw new Error('Please specify target');
    }
    if (!id) {
      runtimeArgs.insert('id', CLValue.option(null, CLTypeHelper.u64()));
    } else {
      runtimeArgs.insert(
        'id',
        CLValue.option(CLTypedAndToBytesHelper.u64(id), CLTypeHelper.u64())
      );
    }
    this.args = runtimeArgs;
  }

  public toBytes(): ByteArray {
    return concat([
      Uint8Array.from([this.tag]),
      toBytesArrayU8(this.args.toBytes())
    ]);
  }
}

@jsonObject
export class ExecutableDeployItemJsonWrapper implements ToBytes {

  @jsonMember({
    name: 'ModuleBytes',
    constructor: ModuleBytes
  })
  public moduleBytes?: ModuleBytes;

  @jsonMember({
    name: 'StoredVersionedContractByHash',
    constructor: StoredContractByHash
  })
  public storedContractByHash?: StoredContractByHash;

  @jsonMember({
    name: 'StoredContractByName',
    constructor: StoredContractByName
  })
  public storedContractByName?: StoredContractByName;

  @jsonMember({
    name: 'StoredVersionedContractByHash',
    constructor: StoredVersionedContractByHash
  })
  public storedVersionedContractByHash?: StoredVersionedContractByHash;

  @jsonMember({
    name: 'StoredVersionedContractByName',
    constructor: StoredVersionedContractByName
  })
  public storedVersionedContractByName?: StoredVersionedContractByName;
  @jsonMember({
    name: 'Transfer',
    constructor: Transfer
  })
  public transfer?: Transfer;

  public toBytes(): ByteArray {
    if (this.isModuleBytes()) {
      return this.moduleBytes!.toBytes();
    } else if (this.isStoredContractByHash()) {
      return this.storedContractByHash!.toBytes();
    } else if (this.isStoredContractByName()) {
      return this.storedContractByName!.toBytes();
    } else if (this.isStoredVersionContractByHash()) {
      return this.storedVersionedContractByHash!.toBytes();
    } else if (this.isStoredVersionContractByName()) {
      return this.storedVersionedContractByName!.toBytes();
    } else if (this.isTransfer()) {
      return this.transfer!.toBytes();
    }
    throw new Error('failed to serialize ExecutableDeployItemJsonWrapper');
  }

  public static fromExecutionDeployItem(item: ExecutableDeployItem) {
    const res = new ExecutableDeployItemJsonWrapper();
    switch (item.tag) {
      case 0:
        res.moduleBytes = item as ModuleBytes;
        break;
      case 1:
        res.storedContractByHash = item as StoredContractByHash;
        break;
      case 2:
        res.storedContractByName = item as StoredContractByName;
        break;
      case 3:
        res.storedVersionedContractByHash = item as StoredVersionedContractByHash;
        break;
      case 4:
        res.storedVersionedContractByName = item as StoredVersionedContractByName;
        break;
      case 5:
        res.transfer = item as Transfer;
        break;
    }
    return res;
  }

  public static newModuleBytes(moduleBytes: ByteArray, args: RuntimeArgs): ExecutableDeployItemJsonWrapper {
    return ExecutableDeployItemJsonWrapper.fromExecutionDeployItem(new ModuleBytes(moduleBytes, args));
  }

  public static newStoredContractByHash(
    hash: Uint8Array,
    version: number | null,
    entryPoint: string,
    args: RuntimeArgs
  ) {
    return ExecutableDeployItemJsonWrapper.fromExecutionDeployItem(new StoredVersionedContractByHash(hash, version, entryPoint, args));
  }

  public static newStoredContractByName(
    name: string,
    entryPoint: string,
    args: RuntimeArgs
  ) {
    return ExecutableDeployItemJsonWrapper.fromExecutionDeployItem(new StoredContractByName(name, entryPoint, args));
  }

  public static newStoredVersionContractByHash(
    hash: Uint8Array,
    version: number | null,
    entryPoint: string,
    args: RuntimeArgs
  ) {
    return ExecutableDeployItemJsonWrapper.fromExecutionDeployItem(new StoredVersionedContractByHash(hash, version, entryPoint, args));
  }

  public static newStoredVersionContractByName(
    name: string,
    version: number | null,
    entryPoint: string,
    args: RuntimeArgs
  ) {
    return ExecutableDeployItemJsonWrapper.fromExecutionDeployItem(new StoredVersionedContractByName(name, version, entryPoint, args));
  }

  public static newTransfer(
    amount: BigNumberish,
    target: URef | PublicKey,
    sourcePurse?: URef,
    id: number | null = null
  ) {
    return ExecutableDeployItemJsonWrapper.fromExecutionDeployItem(new Transfer(amount, target, sourcePurse, id));
  }

  public isModuleBytes(): boolean {
    return !!this.moduleBytes;
  }

  public asModuleBytes(): ModuleBytes | undefined {
    return this.moduleBytes;
  }

  public isStoredContractByHash(): boolean {
    return !!this.storedContractByHash;
  }

  public asStoredContractByHash(): StoredContractByHash | undefined {
    return this.storedContractByHash;
  }

  public isStoredContractByName(): boolean {
    return !!this.storedContractByName;
  }

  public asStoredContractByName(): StoredContractByName | undefined {
    return this.storedContractByName;
  }

  public isStoredVersionContractByName(): boolean {
    return !!this.storedVersionedContractByName;
  }

  public asStoredVersionContractByName(): StoredVersionedContractByName | undefined {
    return this.storedVersionedContractByName;
  }

  public isStoredVersionContractByHash(): boolean {
    return !!this.storedVersionedContractByHash;
  }

  public asStoredVersionContractByHash(): StoredVersionedContractByHash | undefined {
    return this.storedVersionedContractByHash;
  }

  public isTransfer() {
    return !!this.transfer;
  }

  public asTransfer(): Transfer | undefined {
    return this.transfer;
  }
}

/**
 * A deploy containing a smart contract along with the requester's signature(s).
 */
@jsonObject
export class Deploy {
  @jsonMember({
    serializer: byteArrayJsonSerializer,
    deserializer: byteArrayJsonDeserializer
  })
  public hash: ByteArray;

  @jsonMember({ constructor: DeployHeader })
  public header: DeployHeader;

  @jsonMember({
    constructor: ExecutableDeployItemJsonWrapper
  })
  public payment: ExecutableDeployItemJsonWrapper;

  @jsonMember({
    constructor: ExecutableDeployItemJsonWrapper
  })
  public session: ExecutableDeployItemJsonWrapper;

  @jsonArrayMember(Approval)
  public approvals: Approval[];

  /**
   *
   * @param hash The DeployHash identifying this Deploy
   * @param header The deployHeader
   * @param payment The ExecutableDeployItem for payment code.
   * @param session the ExecutableDeployItem for session code.
   * @param approvals  An array of signature and public key of the signers, who approve this deploy
   */
  constructor(
    hash: ByteArray,
    header: DeployHeader,
    payment: ExecutableDeployItemJsonWrapper,
    session: ExecutableDeployItemJsonWrapper,
    approvals: Approval[]
  ) {
    this.approvals = approvals;
    this.session = session;
    this.payment = payment;
    this.header = header;
    this.hash = hash;
  }

  public isTransfer(): boolean {
    return this.session.isTransfer();
  }

  public isStandardPayment(): boolean {
    if (this.payment.isModuleBytes()) {
      return this.payment.asModuleBytes()?.moduleBytes.length === 0;
    }
    return false;
  }
}

/**
 * Serialize deployHeader into a array of bytes
 * @param deployHeader
 */
export const serializeHeader = (deployHeader: DeployHeader) => {
  return deployHeader.toBytes();
};

/**
 * Serialize deployBody into a array of bytes
 * @param payment
 * @param session
 */
export const serializeBody = (
  payment: ExecutableDeployItemJsonWrapper,
  session: ExecutableDeployItemJsonWrapper
) => {
  return concat([payment.toBytes(), session.toBytes()]);
};

/**
 * Supported contract type
 */
export enum ContractType {
  WASM = 'WASM',
  Hash = 'Hash',
  Name = 'Name'
}

export class DeployParams {
  /**
   * Container for `Deploy` construction options.
   * @param accountPublicKey
   * @param chainName Name of the chain, to avoid the `Deploy` from being accidentally or maliciously included in a different chain.
   * @param gasPrice Conversion rate between the cost of Wasm opcodes and the motes sent by the payment code.
   * @param ttl Time that the `Deploy` will remain valid for, in milliseconds. The default value is 3600000, which is 1 hour
   * @param dependencies Hex-encoded `Deploy` hashes of deploys which must be executed before this one.
   * @param timestamp  If `timestamp` is empty, the current time will be used. Note that timestamp is UTC, not local.
   */
  constructor(
    public accountPublicKey: PublicKey,
    public chainName: string,
    public gasPrice: number = 10,
    public ttl: number = 3600000,
    public dependencies: Uint8Array[] = [],
    public timestamp?: number
  ) {
    this.dependencies = dependencies.filter(
      d =>
        dependencies.filter(t => encodeBase16(d) === encodeBase16(t)).length < 2
    );
    if (!timestamp) {
      this.timestamp = Date.now();
    }
  }
}

/**
 * Makes Deploy message
 */
export function makeDeploy(
  deployParam: DeployParams,
  session: ExecutableDeployItemJsonWrapper,
  payment: ExecutableDeployItemJsonWrapper
): Deploy {
  const serializedBody = serializeBody(payment, session);
  const bodyHash = blake.blake2b(serializedBody, null, 32);

  const header: DeployHeader = new DeployHeader(
    deployParam.accountPublicKey,
    deployParam.timestamp!,
    deployParam.ttl,
    deployParam.gasPrice,
    bodyHash,
    deployParam.dependencies,
    deployParam.chainName
  );
  const serializedHeader = serializeHeader(header);
  const deployHash = blake.blake2b(serializedHeader, null, 32);
  return new Deploy(
    deployHash,
    header,
    payment,
    session,
    []
  );
}

/**
 * Uses the provided key pair to sign the Deploy message
 *
 * @param deploy
 * @param signingKey the keyPair to sign deploy
 */
export const signDeploy = (
  deploy: Deploy,
  signingKey: AsymmetricKey
): Deploy => {
  const approval = new Approval();
  const signature = signingKey.sign(deploy.hash);
  approval.signer = signingKey.accountHex();
  switch (signingKey.signatureAlgorithm) {
    case SignatureAlgorithm.Ed25519:
      approval.signature = Keys.Ed25519.accountHex(signature);
      break;
    case SignatureAlgorithm.Secp256K1:
      approval.signature = Keys.Secp256K1.accountHex(signature);
      break;
  }
  deploy.approvals.push(approval);

  return deploy;
};

/**
 * Sets the already generated Ed25519 signature for the Deploy message
 *
 * @param deploy
 * @param sig the Ed25519 signature
 * @param publicKey the public key used to generate the Ed25519 signature
 */
export const setSignature = (
  deploy: Deploy,
  sig: ByteArray,
  publicKey: PublicKey
): Deploy => {
  const approval = new Approval();
  approval.signer = publicKey.toAccountHex();
  switch (publicKey.signatureAlgorithm()) {
    case SignatureAlgorithm.Ed25519:
      approval.signature = Keys.Ed25519.accountHex(sig);
      break;
    case SignatureAlgorithm.Secp256K1:
      approval.signature = Keys.Secp256K1.accountHex(sig);
      break;
  }
  deploy.approvals.push(approval);
  return deploy;
};

/**
 * Standard payment code.
 *
 * @param paymentAmount the number of motes paying to execution engine
 */
export const standardPayment = (paymentAmount: bigint | JSBI) => {
  const paymentArgs = RuntimeArgs.fromMap({
    amount: CLValue.u512(paymentAmount.toString())
  });

  return new ModuleBytes(Uint8Array.from([]), paymentArgs);
};

/**
 * Convert the deploy object to json
 *
 * @param deploy
 */
export const deployToJson = (deploy: Deploy) => {
  const serializer = new TypedJSON(Deploy);
  return {
    deploy: serializer.stringify(deploy)
  };
};

/**
 * Convert the json to deploy object
 *
 * @param json
 */
export const deployFromJson = (json: any) => {
  const serializer = new TypedJSON(Deploy);
  return serializer.parse(json);
};
