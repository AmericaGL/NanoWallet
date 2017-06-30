import Network from '../utils/Network';
import convert from '../utils/convert';
import KeyPair from '../utils/KeyPair';
import CryptoHelpers from '../utils/CryptoHelpers';
import Serialization from '../utils/Serialization';
import helpers from '../utils/helpers';
import Address from '../utils/Address';
import TransactionTypes from '../utils/TransactionTypes';

/** Service to build transactions */
class nemUtils {

    /**
     * Initialize services and properties
     *
     * @param {service} Wallet - The Wallet service
     * @param {service} $http - The angular $http service
     * @param {service} DataBridge - The DataBridge service
     * @param {service} NetworkRequests - The NetworkRequests service
     */
    constructor($q, $http, $filter, $timeout, Wallet, WalletBuilder, DataBridge, NetworkRequests, Alert, Transactions) {
        'ngInject';

        /***
         * Declare services
         */
        this._$q = $q;
        this._$http = $http;
        this._$timeout = $timeout;
        this._$filter = $filter;
        this._Wallet = Wallet;
        this._WalletBuilder = WalletBuilder;
        this._DataBridge = DataBridge;
        this._NetworkRequests = NetworkRequests;
        this._Alert = Alert;
        this._Transactions = Transactions;
        this.disableSuccessAlert = false;

    }

    disableSuccessAlerts() {
        this.disableSuccessAlert = true;
    }

    enableSuccessAlerts() {
        this.disableSuccessAlert = false;
    }

    /**
     * getFirstMessagesWithString(address,str,start) Obtains the last Message that contains string after position start
     *
     * @param {string} address - NEM Address to explore
     * @param {string} str - String to find on addresses txs
     * @param {object} options - Dictionary that can contain:
     *                 options.fromAddress (only return transactions)
     *                 options.start (starting character of the string to look into)
     *
     * @return {promise} - A promise of the NetworkRequests service that returns a string with the filtered message
     */
    getFirstMessageWithString(address, str, options) {

        // Get ALL Transactions since the API only allows us to iterate on a descending order
        return this.getTransactionsWithString(address, str, options).then((result) => {
            let message;
            if (result && result.length > 0) {

                // Get the first message ever
                message = result[result.length - 1].transaction.message;
            }
            return message;
        });
    }

    /**
     * getTransactionsWithString(address, str, start) Obtains every transaction message that contains a certain string (starting from position start)
     *
     * @param {string} address - NEM Address to explore
     * @param {string} str - String to find on addresses txs
     * @param {object} options - Dictionary that can contain:
     *                 options.fromAddress (only return transactions)
     *                 options.start (starting character of the string to look into)
     *                 options.limit - Limit amount of results to return
     *                 options.block - Return only transactions made until this block
     *
     * @return {promise} - A promise of the NetworkRequests service that returns an Array with the filtered messages
     */
    getTransactionsWithString(address, str, options) {

        var trans = [];

        // Options is optional
        if (!options || options.constructor != Object)
            options = {};
        if (!options.start)
            options.start = 0;

        // Recursive promise that will obtain every transaction from/to <address>, order it chronologically and return the ones
        // whose message contains <str>.
        var getTx = (function(txID) {

            // Obtain all transactions to/from the address
            return this._NetworkRequests.getAllTransactionsFromID(helpers.getHostname(this._Wallet.node), address, txID).then((result) => {
                var transactions = result.data;
                // If there transactions were returned and the limit was not reached
                if (transactions.length > 0 && (!options.limit || trans.length < options.limit)) {

                    // IDs are ordered, we grab the latest
                    var last_id = transactions[transactions.length - 1].meta.id;

                    // Order transactions chronologically
                    transactions.sort(function(a, b) {
                        return b.meta.height - a.meta.height;
                    });

                    // Iterate every transaction and add the valid ones to the array
                    for (var i = 0; transactions.length > i && (!options.limit || trans.length < options.limit); i++) {

                        let transaction = transactions[i].transaction;
                        let meta = transactions[i].meta;

                        // Multisig transactions
                        if (transaction.type == 4100) {
                            transaction = transaction.otherTrans;
                        }
                        // Regular transactions (multisig otherTrans is of type 257)
                        if (transaction.type == 257) {
                            // On this version we are only using decoded messages!
                            let msg = this._$filter('fmtHexMessage')(transaction.message);

                            // Check if transaction should be added depending on the message and its signer
                            if (msg.includes(str, options.start) && (!options.fromAddress || Address.toAddress(transaction.signer, this._Wallet.network) == options.fromAddress)) {
                                // We decode the message and store it
                                transaction.message = msg;
                                transactions[i].transaction = transaction;
                                trans[trans.length] = transactions[i];
                            }
                        }
                    }
                    // Keep searching for more transactions after last_id
                    return getTx(last_id);
                } else {
                    return trans;
                }
            });
        }).bind(this);

        return getTx();
    }

    /**
     * processTxData(transferData) Processes transferData
     *
     * @param {object} tx - The transaction data
     *
     * @return {promise} - An announce transaction promise of the NetworkRequests service
     */
    processTxData(transferData) {
        // return if no value or address length < to min address length
        if (!transferData || !transferData.recipient || transferData.recipient.length < 40) {
            return;
        }

        // Clean address
        let recipientAddress = transferData.recipient.toUpperCase().replace(/-/g, '');
        // Check if address is from the same network
        if (Address.isFromNetwork(recipientAddress, this._Wallet.network)) {
            // Get recipient account data from network
            return this._NetworkRequests.getAccountData(helpers.getHostname(this._Wallet.node), recipientAddress).then((data) => {
                // Store recipient public key (needed to encrypt messages)
                transferData.recipientPubKey = data.account.publicKey;
                // Set the address to send to
                transferData.recipient = recipientAddress;
            }, (err) => {
                this._Alert.getAccountDataError(err.data.message);
                return;
            });
        } else {
            // Error
            this._Alert.invalidAddressForNetwork(recipientAddress, this._Wallet.network);
            // Reset recipient data
            throw "invalidAddressForNetwork";
        }
    }

    /**
     * send(entity) Sends a transaction to the network based on an entity
     *
     * @param {object} entity - The prepared transaction object
     * @param {object} common - A password/privateKey object
     *
     * @return {promise} - An announce transaction promise of the NetworkRequests service
     */
    send(entity, common) {
        if (!common.privateKey) {
            this._Alert.invalidPassword();
            throw "privateKey is empty";
        }
        // Construct transaction byte array, sign and broadcast it to the network
        return this._Transactions.serializeAndAnnounceTransaction(entity, common).then((result) => {
            // Check status
            if (result.status === 200) {
                // If code >= 2, it's an error
                if (result.data.code >= 2) {
                    this._Alert.transactionError(result.data.message);
                    throw(result.data.message);
                } else {
                    if (this.disableSuccessAlert == false) {
                        this._Alert.transactionSuccess();
                    }
                }
            }
        }, (err) => {
            this._Alert.transactionError('Failed ' + err.data.error + " " + err.data.message);
            throw(err);
        });
    }

    /**
     * sendMessage(recipientAccount, message, common) Sends a minimal transaction containing a message to poin
     *
     * @param {object} receiver - Transaction receiver's account
     * @param {string} message - Message to be sent
     * @param {object} common -  password/privateKey object
     *
     * @return {promise} - An announce transaction promise of the NetworkRequests service
     */
    sendMessage(receiver, message, common, amount) {

        if (!amount)
            amount = 0;

        var transferData = {};
        // Check that the receiver is a valid account and process it's public key
        transferData.recipient = receiver;
        this.processTxData(transferData);
        // transferData.receiverPubKey is set now

        transferData.amount = amount;
        transferData.message = message;
        transferData.encryptMessage = false; // Maybe better to encrypt?
        transferData.isMultisig = false;
        transferData.isMosaicTransfer = false;

        // Build the entity to be sent
        let entity = this._Transactions.prepareTransfer(common, transferData, this.mosaicsMetaData);
        return this.send(entity, common);
    }

    /**
     * createNewAccount() creates a new account using a random seed
     */
    createNewAccount() {
        var deferred = this._$q.defer();
        var promise = deferred.promise;

        var rk = CryptoHelpers.randomKey();
        var seed = this._Wallet.currentAccount.address + " is creating an account from " + rk;
        // console.log("creating a HDW from "+seed);

        // Create the brain wallet from the seed
        this._WalletBuilder.createBrainWallet(seed, seed, this._Wallet.network).then((wallet) => {
            this._$timeout(() => {
                if (wallet) {
                    var mainAccount = {};
                    mainAccount.address = wallet.accounts[0].address;
                    mainAccount.password = seed;
                    mainAccount.privateKey = "";

                    // Decrypt/generate private key and check it. Returned private key is contained into mainAccount
                    if (!CryptoHelpers.passwordToPrivatekeyClear(mainAccount, wallet.accounts[0], wallet.accounts[0].algo, false)) {
                        this._Alert.invalidPassword();
                        deferred.reject(false);
                    }
                    mainAccount.publicKey = KeyPair.create(mainAccount.privateKey).publicKey.toString();
                    deferred.resolve(mainAccount);
                }
            }, 10);
        }, (err) => {
            this._Alert.createWalletFailed(err);
            deferred.reject(false);
            console.log(err);
        });
        return deferred.promise;
    }

    /**
     * ownsMosaic(address,namespace, mosaic) Checks if address owns any mosaics from namespace:mosaic
     *
     * @param {string} address - NEM Address to check for the mosaic
     * @param {string} namespaceId - Mosaic's namespace name
     * @param {string} mosaic - Mosaic's name
     *
     * @return {promise} - A promise of the NetworkRequests service that returns wether if address owns any mosaics from namespace:mosaic or not
     */
    ownsMosaic(address, namespace, mosaic) {
        var deferred = this._$q.defer();
        var promise = deferred.promise;
        this._NetworkRequests.getMosaicsDefinitions(helpers.getHostname(this._Wallet.node), address).then((result) => {
            let owns = false;
            if (result.data.length) {
                for (let i = 0; i < result.data.length; ++i) {
                    let rNamespace = result.data[i].id.namespaceId;
                    let rMosaic = result.data[i].id.name;
                    if (namespace == rNamespace && mosaic == rMosaic) {
                        owns = true;
                    }
                }
            }
            deferred.resolve(owns);
        }, (err) => {
            if (err.status === -1) {
                this._Alert.connectionError();
            } else {
                this._Alert.errorGetMosaicsDefintions(err.data.message);
            }
        });
        return deferred.promise;
    }

    /**
     * isValidAddress(address) checks if address is a valid address in the current network
     *
     * @param {string} address - NEM Address to check
     *
     * @return {boolean} - Returns wether the address is valid in the current network or not
     */
    isValidAddress(address) {
        let addr = address.toUpperCase().replace(/-/g, '');

        return (Address.isValid(addr) && Address.isFromNetwork(addr, this._Wallet.network));
    }

    /**
     * getImportance(address) gets the importance score of an account
     *
     * @param {string} address - NEM address
     * @param {integer} block - the block in which to request importance. Optional
     *
     * @return {promise} - A promise that returns the account's importance score
     */
    getImportance(address, block) {
        if (!block || (block < 0)) {
            return this._NetworkRequests.getAccountData(helpers.getHostname(this._Wallet.node), address).then((data) => {
                return data.account.importance;
            }).catch();
        } else {

            if (this._Wallet.network < 0) {
                // Node with historical data activated
                return this._NetworkRequests.getHistoricalAccountData('104.128.226.60', address, block).then((data) => {
                    return data.data.data[0].importance;
                }).catch();
            } else {
                // Node with historical data activated
                return this._NetworkRequests.getHistoricalAccountData('hugealice.nem.ninja', address, block).then((data) => {
                    return data.data.data[0].importance;
                }).catch();
            }
        }
    }

    /**
     * getOwnedMosaics(address) returns the number of a certain mosaic owned by an account
     *
     * @param {string} address - NEM address
     * @param {string} namespace - NEM namespace
     * @param {string} name - the name of the mosaic
     *
     * @return {promise} - A promise that returns the account's number of owned mosaics
     */
    getOwnedMosaics(address, namespace, name) {
        return this._NetworkRequests.getOwnedMosaics(helpers.getHostname(this._Wallet.node), address).then((data) => {
            var filtered = data.filter((mosaic) => {
                return (mosaic.mosaicId.namespaceId === namespace) && (mosaic.mosaicId.name === name);
            });
            return (filtered.length < 1)
                ? (0)
                : (filtered[0].quantity);
        }).catch();
    }

    /**
     * getCurrentHeight(address) returns the current blockchain height
     *
     * @return {promise} - A promise that returns the blockchain's height
     */
    getCurrentHeight() {
        return this._NetworkRequests.getHeight(helpers.getHostname(this._Wallet.node));
    }

    /**
     * getTransactionFee(message, amount) returns the fee that a message would cost
     *
     * @param {string} message - message to be sent
     * @param {integer} amount - xm amount to be sent
     *
     * @return {integer} - An integer value that represents the fee in xem
     */
    getMessageFee(message, amount) {
        if (!amount)
            amount = 0;
        var common = {
            "password": "",
            "privateKey": ""
        };
        var formData = {};
        formData.rawRecipient = '';
        formData.recipient = '';
        formData.recipientPubKey = '';
        formData.message = message;
        //var rawAmount = amount;
        formData.fee = 0;
        formData.encryptMessage = false;
        // Multisig data
        formData.innerFee = 0;
        formData.isMultisig = false;
        formData.multisigAccount = '';
        // Mosaics data
        var counter = 1;
        formData.mosaics = null;
        var mosaicsMetaData = this._DataBridge.mosaicDefinitionMetaDataPair;
        formData.isMosaicTransfer = false;

        formData.amount = helpers.cleanAmount(amount);
        let entity = this._Transactions.prepareTransfer(common, formData, mosaicsMetaData);
        formData.innerFee = 0;
        formData.fee = entity.fee;
        return formData.fee;
    }

    /**
     * existsTransaction(address1, address2) returns wether address 1 has ever sent a transaction to address2
     *
     * @param {string} address1 - sender address
     * @param {string} address2 - receiver address
     *
     * @return {number} - a promise that returns:
     *                      0 if the transaction doesn't exist
     *                      1 if the transaction exists but is unconfirmed
     *                      2 if the transaction exists and is confirmed
     */
    existsTransaction(address1, address2) {
        var options = {
            fromAddress: address1,
            limit: 1
        }
        return this.getTransactionsWithString(address2, '', options).then((data) => {
            if (data.length !== 0) {
                console.log("transaction", data);
                console.log("add", Address.toAddress(data[0].transaction.signer), this._Wallet.network);
                return 2;
            } else {
                return this._NetworkRequests.getUnconfirmedTxes(helpers.getHostname(this._Wallet.node), address1).then((transactions) => {
                    for (var i = 0; i < transactions.length; i++) {
                        if (transactions[i].transaction.recipient === address2) {
                            return 1;
                        }
                    }
                    return 0;
                }).catch();
            }
        });
    }

    /**
     * getHeightByTimestamp(timestamp) returns the last harvested block at the time of the timestamp
     *
     * @param {integer} timestamp - javascript timestamp
     *
     * @return {promise} - a promise that returns the block height
     */
    getHeightByTimestamp(timestamp) {
        //1.Approximate (60s average block time)
        console.log("ts", timestamp);
        let nemTimestamp = helpers.toNEMTimeStamp(timestamp);
        let now = helpers.toNEMTimeStamp((new Date()).getTime());
        let elapsed = now - nemTimestamp;
        //get current height and approx from there
        return this.getCurrentHeight().then((curHeight) => {

            let height = Math.floor(curHeight - (elapsed / 60));
            console.log("block estimation->", height);
            //2.Find exact block

            const findBlock = function(height) {
                return this._NetworkRequests.getBlockByHeight(helpers.getHostname(this._Wallet.node), height).then((block) => {
                    let x = Math.floor((nemTimestamp - block.data.timeStamp) / 60);
                    if (x < 0 && x > -5)
                        x = -1;
                    if (x > 0 && x < 5)
                        x = 1;
                    if (block.data.timeStamp <= nemTimestamp) {
                        return this._NetworkRequests.getBlockByHeight(helpers.getHostname(this._Wallet.node), height + 1).then((nextBlock) => {
                            //check if target
                            if (nextBlock.data.timeStamp > nemTimestamp) {
                                console.log("found", height);
                                return height;
                            } else {
                                console.log("go up", height, "+", x);
                                return findBlock(height + x);
                            }
                        });
                    } else {
                        console.log("go down", height, x);
                        return findBlock(height + x);
                    }
                });
            }.bind(this);

            return findBlock(height);
        });
    }
}

export default nemUtils;
