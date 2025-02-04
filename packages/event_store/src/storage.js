const sequelize = require('sequelize');
const { Op, QueryTypes } = sequelize;
const { BigNumber } = require('@ethersproject/bignumber');

const { formatDate } = require('./utility');

class Storage {
    constructor(models, casperClient, pubsub = null) {
        this.models = models;
        this.casperClient = casperClient;
        this.pubsub = pubsub;

        this.withGenesisAccountsTracking = false;
        this.genesisAccountHashesMap = {};
    }

    async enableGenesisAccountsTracking() {
        this.withGenesisAccountsTracking = true;
        this.genesisAccountHashesMap = await this.getGenesisAccountHashesMap();
    }

    async storeEntity(model, entity) {
        try {
            return await this.models[model].create(entity);
        }
        catch (err) {
            if (err instanceof sequelize.UniqueConstraintError) {
                console.warn(`Warning: ${model} with primary key ${err.fields.PRIMARY} already exists. Skipping.`);
                return false;
            }
            else {
                console.warn(err);
                throw err;
            }
        }
    }

    async onEventId(sourceNodeId, apiVersionId, eventStreamId, id) {
        console.log(`Info: Processing id ${id} from source node ${sourceNodeId}, stream path ${eventStreamId}, protocol version ${apiVersionId}`);
        this.storeEntity('EventId', { sourceNodeId, apiVersionId, eventStreamId, id });
    }

    async onEvent(sourceNodeId, apiVersion, jsonBody) {
        const event = JSON.parse(jsonBody);

        if (event.DeployAccepted) {
            this.storeEntity('RawDeployAcceptedEvent', {
                sourceNodeId,
                apiVersionId: apiVersion.id,
                deployHash: event.DeployAccepted.hash,
                jsonBody,
            });
        } else if (event.DeployProcessed) {
            this.storeEntity('RawDeployProcessedEvent', {
                sourceNodeId,
                apiVersionId: apiVersion.id,
                deployHash: event.DeployProcessed.deploy_hash,
                jsonBody,
            });

            this.onDeployProcessedEvent(event.DeployProcessed);
        } else if (event.BlockAdded) {
            this.storeEntity('RawBlockAddedEvent', {
                sourceNodeId,
                apiVersionId: apiVersion.id,
                blockHeight: event.BlockAdded.block.header.height,
                jsonBody,
            });

            this.onBlockAddedEvent(event.BlockAdded, apiVersion);
        } else if (event.FinalitySignature) {
            this.storeEntity('RawFinalitySignatureEvent', {
                sourceNodeId,
                apiVersionId: apiVersion.id,
                signature: event.FinalitySignature.signature,
                jsonBody,
            });

            this.onFinalitySignatureEvent(event.FinalitySignature);
        } else if (event.Step) {
            this.storeEntity('RawStepEvent', {
                sourceNodeId,
                apiVersionId: apiVersion.id,
                eraId: event.Step.era_id,
                jsonBody,
            });
        }
        else {
            const keys = Object.keys(event);
            const eventType = keys.length > 0 ? keys[0] : '';

            this.storeEntity('RawUnrecognizedEvent', {
                sourceNodeId,
                apiVersionId: apiVersion.id,
                eventType,
                jsonBody,
            });
        }
    }

    async onDeployProcessedEvent(event) {
        console.log(`Info: Processing DeployProcessed event. DeployHash: ${event.deploy_hash}.`);

        let deployData = {
            blockHash: event.block_hash,
            deployHash: event.deploy_hash,
            account: event.account,
            timestamp: event.timestamp,
        };

        if (event.execution_result.Success) {
            let result = event.execution_result.Success;
            deployData.cost = result.cost;
            deployData.errorMessage = null;
        } else {
            let result = event.execution_result.Failure;
            deployData.errorMessage = result.error_message;
            deployData.cost = result.cost;
        }

        const result = this.storeEntity('Deploy', deployData);

        if (result !== false && event.execution_result.Success) {
            let result = event.execution_result.Success;
            let transferHashes = result.transfers;

            for (let transform of result.effect.transforms) {
                if (transferHashes.includes(transform.key)) {
                    let transferEvent = transform.transform.WriteTransfer;

                    let transfer = {
                        transferHash: transform.key,
                        deployHash: deployData.deployHash,
                        blockHash: deployData.blockHash,
                        fromAccount: transferEvent.from.substring(13),
                        toAccount: transferEvent.to
                            ? transferEvent.to.substring(13)
                            : null,
                        sourcePurse: transferEvent.source,
                        targetPurse: transferEvent.target,
                        amount: transferEvent.amount,
                        transferId: transferEvent.id,
                        timestamp: event.timestamp,
                    };

                    this.storeEntity('Transfer', transfer);

                    if (
                        this.withGenesisAccountsTracking &&
                        this.genesisAccountHashesMap.hasOwnProperty(transfer.fromAccount)
                    ) {
                        // If the genesis accounts tracking is enabled and the transfer comes
                        // from a genesis account then let's track the transfer separately
                        this.storeEntity('GenesisAccountTransfer', {
                            ...transfer,
                            isInternal: this.genesisAccountHashesMap.hasOwnProperty(transfer.toAccount) ? 1 : 0,
                            isIgnored: BigNumber.from(transfer.amount).gte('5000000000000000'), // 5 million tokens
                            isReviewed: 0,
                        });
                    }
                }

                if (transform.transform) {
                    if (transform.transform.WriteBid) {
                        let bidEvent = transform.transform.WriteBid;
                        this.storeEntity('Bid', {
                            key: transform.key,
                            deployHash: event.deploy_hash,
                            validatorPublicKey: bidEvent.validator_public_key,
                            bondingPurse: bidEvent.bonding_purse,
                            stakedAmount: bidEvent.staked_amount,
                            delegationRate: bidEvent.delegation_rate,
                            inactive: bidEvent.inactive,
                            vestingSchedule: bidEvent.vesting_schedule,
                            delegators: bidEvent.delegators,
                            timestamp: event.timestamp,
                        });
                    }
                    else if (transform.transform.WriteWithdraw) {
                        for (let withdrawalEvent of transform.transform.WriteWithdraw) {
                            this.storeEntity('Withdrawal', {
                                key: transform.key,
                                deployHash: event.deploy_hash,
                                validatorPublicKey: withdrawalEvent.validator_public_key,
                                unbonderPublicKey: withdrawalEvent.unbonder_public_key,
                                bondingPurse: withdrawalEvent.bonding_purse,
                                amount: withdrawalEvent.amount,
                                eraOfCreation: withdrawalEvent.era_of_creation,
                                timestamp: event.timestamp,
                            });
                        }
                    }
                }
            }
        }

        if (this.pubsub !== null) {
            this.pubsub.broadcast_deploy(await deploy.toJSON());
        }
    }

    isVersionGreaterOrEqual(v1, v2) {
        const v1Parts = v1.split('.').map(v => Number(v));
        const v2Parts = v2.split('.').map(v => Number(v));

        return (v1Parts[0] > v2Parts[0]) ||
            (v1Parts[0] === v2Parts[0] && v1Parts[1] > v2Parts[1]) ||
            (v1Parts[0] === v2Parts[0] && v1Parts[1] === v2Parts[1] && v1Parts[2] > v2Parts[2]) ||
            (v1Parts[0] === v2Parts[0] && v1Parts[1] === v2Parts[1] && v1Parts[2] === v2Parts[2]);
    }

    async onBlockAddedEvent(event, apiVersion) {
        const deployCount = event.block.body.deploy_hashes.length;
        const transferCount = event.block.body.transfer_hashes.length;

        console.log(`Info: Processing BlockAdded event. BlockHash: ${event.block_hash}`);

        this.storeEntity('Block', {
            blockHash: event.block.hash,
            blockHeight: event.block.header.height,
            parentHash: event.block.header.parent_hash,
            timestamp: event.block.header.timestamp,
            state: event.block.header.state_root_hash,
            deployCount: deployCount,
            transferCount: transferCount,
            eraId: event.block.header.era_id,
            proposer: event.block.body.proposer,
        });

        if (event.block.header.era_end) {
            this.storeEntity('Era', {
                id: event.block.header.era_id,
                endBlockHeight: event.block.header.height,
                endTimestamp: event.block.header.timestamp,
                protocolVersion: event.block.header.protocol_version,
            });

            const eraSummary = await this.casperClient.getEraInfoBySwitchBlockHeight(event.block.header.height);

            for (const reward of eraSummary.stored_value.EraInfo.seigniorage_allocations) {
                if (reward.Validator) {
                    this.storeEntity('ValidatorReward', {
                        eraId: eraSummary.era_id,
                        publicKey: reward.Validator.validator_public_key,
                        amount: reward.Validator.amount,
                        timestamp: event.block.header.timestamp,
                    });
                }
                else if (reward.Delegator) {
                    this.storeEntity('DelegatorReward', {
                        eraId: eraSummary.era_id,
                        publicKey: reward.Delegator.delegator_public_key,
                        validatorPublicKey: reward.Delegator.validator_public_key,
                        amount: reward.Delegator.amount,
                        timestamp: event.block.header.timestamp,
                    });
                }
            }

            if (this.isVersionGreaterOrEqual(apiVersion.version, '1.2.0')) {
                for (let validator of event.block.header.era_end.next_era_validator_weights) {
                    this.storeEntity('EraValidator', {
                        eraId: event.block.header.era_id + 1,
                        publicKeyHex: validator.validator,
                        weight: validator.weight,
                        rewards: 0,
                        hasEquivocation: 0,
                        wasActive: 0,
                    });
                }
            }
            else {
                for (let publicKeyHex in event.block.header.era_end.next_era_validator_weights) {
                    this.storeEntity('EraValidator', {
                        eraId: event.block.header.era_id + 1,
                        publicKeyHex: publicKeyHex,
                        weight: event.block.header.era_end.next_era_validator_weights[publicKeyHex],
                        rewards: 0,
                        hasEquivocation: 0,
                        wasActive: 0,
                    });
                }
            }

            const updatedValidators = [];
            if (this.isVersionGreaterOrEqual(apiVersion.version, '1.2.0')) {
                for (let validator of event.block.header.era_end.era_report.rewards) {
                    updatedValidators.push(validator.validator);

                    this.models.EraValidator.update({
                        rewards: validator.amount,
                        hasEquivocation: event.block.header.era_end.era_report.equivocators.includes(validator.validator),
                        wasActive: !event.block.header.era_end.era_report.inactive_validators.includes(validator.validator),
                    }, {
                        where: {
                            eraId: event.block.header.era_id,
                            publicKeyHex: validator.validator,
                        }
                    });
                }
            }
            else {
                for (let publicKeyHex in event.block.header.era_end.era_report.rewards) {
                    updatedValidators.push(publicKeyHex);

                    this.models.EraValidator.update({
                        rewards: event.block.header.era_end.era_report.rewards[publicKeyHex],
                        hasEquivocation: event.block.header.era_end.era_report.equivocators.includes(publicKeyHex),
                        wasActive: !event.block.header.era_end.era_report.inactive_validators.includes(publicKeyHex),
                    }, {
                        where: {
                            eraId: event.block.header.era_id,
                            publicKeyHex: publicKeyHex,
                        }
                    });
                }
            }

            for (let publicKeyHex of event.block.header.era_end.era_report.equivocators) {
                if (updatedValidators.includes(publicKeyHex)) {
                    continue;
                }

                updatedValidators.push(publicKeyHex);

                this.models.EraValidator.update({
                    hasEquivocation: true,
                    wasActive: !event.block.header.era_end.era_report.inactive_validators.includes(publicKeyHex),
                }, {
                    where: {
                        eraId: event.block.header.era_id,
                        publicKeyHex: publicKeyHex,
                    }
                });
            }

            for (let publicKeyHex of event.block.header.era_end.era_report.inactive_validators) {
                if (updatedValidators.includes(publicKeyHex)) {
                    continue;
                }

                this.models.EraValidator.update({
                    wasActive: false,
                }, {
                    where: {
                        eraId: event.block.header.era_id,
                        publicKeyHex: publicKeyHex,
                    }
                });
            }
        }

        if(this.pubsub !== null) {
            this.pubsub.broadcast_block(await block.toJSON());
        }
    }

    async onEraEnd(eraEnd) {
        this.storeEntity('Era', {
            eraId: eraEnd.era_id,
            eraEndBlockHeight: eraEnd.era_end_block_height,
            eraEndTimestamp: eraEnd.era_end_timestamp,
            eraProtocolVersion: eraEnd.era_protocol_version,
        });
    }

    async onFinalitySignatureEvent(event) {
        console.log(`Info: Processing FinalitySignature event. Signature: ${event.signature}.`);

        this.storeEntity('FinalitySignature', {
            signature: event.signature,
            blockHash: event.block_hash,
            publicKey: event.public_key,
            eraId: event.era_id,
        });
    }

    async findBlockByHeight(height) {
        return this.models.Block.findByPk(height);
    }

    async findSourceNodeByAddressOrCreate(address) {
        const found = await this.models.SourceNode.findOne({
            where: { address }
        });

        if (found) {
            return found;
        }

        return await this.storeEntity('SourceNode', { address });
    }

    async findApiVersionByVersionOrCreate(version) {
        const found = await this.models.ApiVersion.findOne({
            where: { version }
        });

        if (found) {
            return found;
        }

        return await this.storeEntity('ApiVersion', { version });
    }

    async findEventStreamByPathOrCreate(path) {
        const found = await this.models.EventStream.findOne({
            where: { path }
        });

        if (found) {
            return found;
        }

        return await this.storeEntity('EventStream', { path });
    }


    async getLastEventId(sourceNodeId, apiVersionId, eventStreamId) {
        const eventId = await this.models.EventId.findOne({
            where: { sourceNodeId, apiVersionId, eventStreamId },
            order: [[ 'id', 'DESC' ]],
            limit: 1,
        });

        return eventId;
    }

    async findBlockByHash(blockHash) {
        return this.models.Block.findOne({
            where: {
                blockHash: blockHash
            }
        });
    }

    buildWhere(criteria, availableCriteriaFields) {
        const where = {};
        for (let criterion in criteria) {
            if (availableCriteriaFields.includes(criterion)) {
                where[criterion] = criteria[criterion]
            }
        }

        return where
    }

    buildOrder(orderBy, orderDirection, availableOrderFields, defaultOrder) {
        let order = defaultOrder;
        if (orderBy && availableOrderFields.includes(orderBy)) {
            order = [[orderBy, orderDirection ? orderDirection : 'DESC']];
        }

        return order
    }

    async findBlocks(criteria, limit, offset, orderBy, orderDirection) {
        return await this.models.Block.findAndCountAll({
            where: this.buildWhere(criteria, ['proposer', 'eraId', 'blockHeight', 'blockHash']),
            order: this.buildOrder(
                orderBy,
                orderDirection,
                ['blockHeight', 'deployCount', 'transferCount', 'timestamp', 'eraId'],
                [['blockHeight', 'DESC']]
            ),
            limit: limit,
            offset: offset,
        });
    }

    async findDeployByHash(deployHash) {
        return this.models.Deploy.findByPk(deployHash);
    }

    async findDeploysByAccount(account, limit, offset, orderBy, orderDirection) {
        return this.models.Deploy.findAndCountAll({
            where: {
                account: account
            },
            order: this.buildOrder(
                orderBy,
                orderDirection,
                ['cost', 'timestamp', 'errorMessage'],
                [['timestamp', 'DESC']]
            ),
            limit: limit,
            offset: offset,
        });
    }

    async findDeployHashesByBlockHash(blockHash) {
        return this.models.Deploy.findAll({
            attributes: ['deployHash'],
            where: {
                blockHash: blockHash
            }
        }).then(deploys => {
            return deploys.map(deploy => deploy.deployHash)
        });
    }

    async findAccountTransfers(accountHash, limit, offset, orderBy, orderDirection) {
        return this.models.Transfer.findAndCountAll({
            where: {
                [Op.or]: [
                    {
                        fromAccount: accountHash
                    },{
                        toAccount: accountHash
                    }
                ]
            },
            order: this.buildOrder(
                orderBy,
                orderDirection,
                ['amount', 'timestamp'],
                [['timestamp', 'DESC']]
            ),
            limit: limit,
            offset: offset,
        });
    }

    async getDeploys(criteria, limit, offset, orderBy, orderDirection) {
        return await this.models.Deploy.findAndCountAll({
            where: this.buildWhere(criteria, ['blockHash', 'account']),
            limit: limit,
            offset: offset,
            order: this.buildOrder(
                orderBy,
                orderDirection,
                ['cost', 'timestamp', 'errorMessage'],
                [['timestamp', 'DESC']]
            ),
        });
    }

    async getRawDeploys(criteria, limit, offset, orderBy, orderDirection) {
        return await this.models.RawDeployProcessedEvent.findAndCountAll({

            attributes: [
                "deployHash",
                [
                    sequelize.literal('jsonBody->>\'$.DeployProcessed.block_hash\''),
                    "blockHash"
                ],
                [
                    sequelize.literal('jsonBody->>\'$.DeployProcessed.account\''),
                    "account"
                ],
                [
                    sequelize.literal('JSON_EXTRACT( jsonBody->>\'$.DeployProcessed.execution_result.*.cost\', \'$[0]\')'),
                    "cost"
                ],
                [
                    sequelize.literal('JSON_EXTRACT(jsonBody->>\'$.DeployProcessed.execution_result.*.error_message\', \'$[0]\')'),
                    "error_message"
                ],
                [
                    sequelize.literal('jsonBody->>\'$.DeployProcessed.timestamp\''),
                    "timestamp"
                ],
                [
                    sequelize.literal('JSON_EXTRACT(jsonBody->>\'$.DeployProcessed.execution_result.*.transfers\', \'$[0]\')'),
                    "transfers"
                ],
                // [
                //     sequelize.literal('JSON_EXTRACT(jsonBody->>\'$.DeployProcessed.execution_result\', \'$[0]\')'),
                //     "execution_result"
                // ],
                // [
                //     sequelize.literal('JSON_EXTRACT(jsonBody, \'$**.WriteTransfer\')'),
                //     "transfer_details"
                // ],
                // [
                //     sequelize.literal('JSON_EXTRACT(jsonBody, \'$**.WriteBid\')'),
                //     "bid_details"
                // ],
                // [
                //     sequelize.literal('JSON_EXTRACT(jsonBody, \'$**.WriteWithdraw\')'),
                //     "withdraw_details"
                // ],
                [
                    sequelize.literal('JSON_EXTRACT( JSON_EXTRACT(jsonBody, \'$**.WriteTransfer.amount\'), \'$[0]\')'),
                    "amount"
                ],
                [
                    sequelize.literal('JSON_EXTRACT( JSON_EXTRACT(jsonBody, \'$**.WriteTransfer.id\'), \'$[0]\')'),
                    "transfer_id"
                ],
                [
                    sequelize.literal('REPLACE(JSON_UNQUOTE(JSON_EXTRACT( JSON_EXTRACT(jsonBody, \'$**.WriteTransfer.to\'), \'$[0]\')), \'account-hash-\', \'\')'),
                    "transfer_recipient_account_hash"
                ],
                [
                    sequelize.literal('IF (JSON_EXTRACT( jsonBody->>\'$.DeployProcessed.execution_result.*.cost\', \'$[0]\') = "10000" AND JSON_EXTRACT(jsonBody, \'$**.WriteWithdraw\') IS NULL, 1, 0 )'),
                    "is_transfer"
                ],
                [
                    sequelize.literal('IF (JSON_EXTRACT(jsonBody, \'$**.WriteBid\') IS NOT NULL AND JSON_EXTRACT(jsonBody, \'$**.WriteWithdraw\') IS NULL, 1, 0 )'),
                    "is_delegate"
                ],
                [
                    sequelize.literal('IF (JSON_EXTRACT(jsonBody, \'$**.WriteWithdraw\') IS NOT NULL , 1, 0 )'),
                    "is_undelegate"
                ],
                [
                    sequelize.literal('JSON_EXTRACT( JSON_EXTRACT(jsonBody, \'$**.WriteBid.validator_public_key\'), \'$[0]\')'),
                    "delegate_undelegate_validator"
                ],

            ],
            // @todo may no longer work with JSON path - needs alias
            where: this.buildWhere(criteria, [sequelize.literal('jsonBody->>\'$.DeployProcessed.block_hash\''), sequelize.literal('jsonBody->>\'$.DeployProcessed.account\'')]),
            limit: limit,
            offset: offset,
            // @todo may no longer work with JSON path - needs alias
            order: this.buildOrder(
                orderBy,
                orderDirection,
                ['cost', 'timestamp', 'errorMessage'],
                [[sequelize.literal('jsonBody->>\'$.DeployProcessed.timestamp\''), 'DESC']]
            ),
        });
    }

    async findRawDeploy(deployHash) {
        const rawEvent = await this.models.RawEvent.findOne({
            where: {
                eventType: 'DeployProcessed',
                primaryEntityHash: deployHash,
            },
        });

        return rawEvent ? JSON.parse(rawEvent.jsonBody).DeployProcessed : null;
    }

    async findTransfers(criteria, limit, offset, orderBy, orderDirection) {
        let where = this.buildWhere(criteria, ['blockHash', 'deployHash', 'transferId']);
        if (criteria['accountHash']) {
            where = {
                [Op.and]: [
                    where,
                    {
                        [Op.or]: [
                            {
                                fromAccount: criteria['accountHash']
                            },
                            {
                                toAccount: criteria['accountHash']
                            }
                        ]
                    }
                ]
            }
        }

        return await this.models.Transfer.findAndCountAll({
            where: where,
            order: this.buildOrder(
                orderBy,
                orderDirection,
                ['amount', 'timestamp'],
                [['timestamp', 'DESC']]
            ),
            limit: limit,
            offset: offset,
        });
    }

    async findEraValidators(criteria, limit, offset, orderBy, orderDirection) {
        return await this.models.EraValidator.findAndCountAll({
            where: this.buildWhere(criteria, ['eraId', 'publicKeyHex', 'hasEquivocation', 'wasActive']),
            order: this.buildOrder(
                orderBy,
                orderDirection,
                ['eraId', 'weight', 'rewards', 'hasEquivocation', 'wasActive', 'createdAt'],
                [['eraId', 'DESC']]
            ),
            limit,
            offset,
        });
    }

    async getTotalValidatorRewards(publicKey) {
        const result = await this.models.sequelize.query(
            'SELECT CAST(SUM(amount) AS char) AS total FROM `ValidatorRewards` WHERE publicKey = $1', {
                bind: [publicKey],
                type: QueryTypes.SELECT,
                plain: true
            }
        );

        return result.total === null ? '0' : result.total;
    }

    async getTotalValidatorDelegatorRewards(validatorPublicKey) {
        const result = await this.models.sequelize.query(
            'SELECT CAST(SUM(amount) AS char) AS total FROM `DelegatorRewards` WHERE validatorPublicKey = $1', {
                bind: [validatorPublicKey],
                type: QueryTypes.SELECT,
                plain: true
            }
        );

        return result.total === null ? '0' : result.total;
    }

    async findValidatorRewards(criteria, limit, offset, orderBy, orderDirection) {
        return await this.models.ValidatorReward.findAndCountAll({
            where: this.buildWhere(criteria, ['publicKey']),
            order: this.buildOrder(
                orderBy,
                orderDirection,
                ['eraId', 'amount', 'timestamp'],
                [['eraId', 'DESC']]
            ),
            limit: limit,
            offset: offset,
        });
    }

    async findDelegatorRewards(criteria, limit, offset, orderBy, orderDirection) {
        return await this.models.DelegatorReward.findAndCountAll({
            limit: limit,
            offset: offset,
            where: this.buildWhere(criteria, ['publicKey', 'validatorPublicKey']),
            order: this.buildOrder(
                orderBy,
                orderDirection,
                ['eraId', 'amount', 'timestamp'],
                [['eraId', 'DESC'], ['validatorPublicKey', 'ASC']]
            ),
        });
    }

    async getTotalDelegatorRewards(publicKey) {
        const result = await this.models.sequelize.query(
            'SELECT CAST(SUM(amount) AS char) AS total FROM `DelegatorRewards` WHERE publicKey = $1', {
                bind: [publicKey],
                type: QueryTypes.SELECT,
                plain: true
            }
        );

        return result.total === null ? '0' : result.total;
    }

    async findCurrencyRatesInDateRange(currencyId, from, to) {
        return await this.models.Rate.findAll({
            where: {
                currency_id: currencyId,
                [Op.and]: [
                    {
                        created: {[Op.gt]: from}
                    },
                    {
                        created: {[Op.lt]: to}
                    }
                ]
            },
            order: [['created', 'ASC']]
        });
    }

    async findCurrencyRatesForDates(currencyId, dates) {
        return await this.models.Rate.findAll({
            where: {
                currency_id: currencyId,
                created: {[Op.in]: dates},
            },
            order: [['created', 'ASC']]
        });
    }

    async getLatestRate(currencyId) {
        const now = Date.now();
        const oneMinute = 1000 * 60;

        const lastFiveMinutes = [
            formatDate(new Date( now - oneMinute * 4)),
            formatDate(new Date( now - oneMinute * 3)),
            formatDate(new Date( now - oneMinute * 2)),
            formatDate(new Date( now - oneMinute)),
            formatDate(new Date( now)),
        ];

        const latestRates = await this.findCurrencyRatesForDates(
            currencyId,
            lastFiveMinutes
        );

        return latestRates.length > 0 ? latestRates[0] : null;
    }

    async findReleaseSchedule(date) {
        return await this.models.TokenReleaseSchedule.findOne({
            where: {
                date: {[Op.gt]: date},
            },
            order: [['date', 'ASC']]
        });
    }

    async getGenesisAccountHashesMap() {
        const genesisAccountHashesMap = {};
        const genesisAccounts = await this.models.GenesisAccount.findAll();
        for (const genesisAccount of genesisAccounts) {
            genesisAccountHashesMap[genesisAccount.accountHash] = true;
        }

        return genesisAccountHashesMap;
    }

    async getGenesisAccounts() {
        return this.models.GenesisAccount.findAll();
    }

    async getTokensMovedBetweenGenesisAccounts() {
        return this.models.GenesisAccountTransfer.findAll({
            attributes: [
                'fromAccount',
                'toAccount',
                [sequelize.fn('sum', sequelize.col('amount')), 'amount'],
            ],
            where: {
                'isInternal': 1,
                'isIgnored': 0,
            },
            group: ['fromAccount', 'toAccount'],
        });
    }

    async getTokensMovedOutOfGenesisAccounts() {
        return this.models.GenesisAccountTransfer.findAll({
            attributes: [
                'fromAccount',
                [sequelize.fn('sum', sequelize.col('amount')), 'amount'],
            ],
            where: {
                'isInternal': 0,
                'isIgnored': 0,
            },
            group: ['fromAccount'],
        });
    }

    async findGenesisAccountsTransfers(criteria, limit, offset, orderBy, orderDirection) {
        let where = this.buildWhere(criteria, [
            'blockHash',
            'deployHash',
            'transferId',
            'fromAccount',
            'toAccount',
            'isInternal',
            'isIgnored',
            'isReviewed',
        ]);

        return await this.models.GenesisAccountTransfer.findAndCountAll({
            where: where,
            order: this.buildOrder(
                orderBy,
                orderDirection,
                ['amount', 'timestamp'],
                [['timestamp', 'DESC']]
            ),
            limit: limit,
            offset: offset,
        });
    }

}

module.exports = Storage;
