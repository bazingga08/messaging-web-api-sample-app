import { useEffect, useState } from "react";
import * as EventSourcePolyfill from "../helpers/eventsource-polyfill.js";

// Import children components to plug in and render.
import MessagingHeader from "./messagingHeader";
import MessagingBody from "./messagingBody";
import MessagingInputFooter from "./messagingInputFooter";

import { setJwt, setLastEventId, storeConversationId, getConversationId, getJwt, clearInMemoryData, setDeploymentConfiguration } from "../services/dataProvider";
import { subscribeToEventSource, closeEventSource } from '../services/eventSourceService';
import { sendTextMessage, getContinuityJwt, listConversations, listConversationEntries, closeConversation, getUnauthenticatedAccessToken, createConversation } from "../services/messagingService";
import * as ConversationEntryUtil from "../helpers/conversationEntryUtil";
import { CONVERSATION_CONSTANTS, STORAGE_KEYS } from "../helpers/constants";
import { setItemInWebStorage, clearWebStorage } from "../helpers/webstorageUtils";
import { util } from "../helpers/common";

export default function Conversation(props) {
    // Initialize a list of conversation entries.
    let [conversationEntries, setConversationEntries] = useState([]);
    // Initialize the conversation status.
    let [conversationStatus, setConversationStatus] = useState(CONVERSATION_CONSTANTS.ConversationStatus.NOT_STARTED_CONVERSATION);

    useEffect(() => {
        let conversationStatePromise;

        conversationStatePromise = props.isExistingConversation ? handleExistingConversation() : handleNewConversation();
        conversationStatePromise
        .then(() => {
            handleSubscribeToEventSource()
            .then(props.uiReady(true)); // Let parent (i.e. MessagingWindow) know the app is UI ready so that the parent can decide to show the actual Messaging window UI.
        });

        return () => {
            conversationStatePromise
            .then(() => {
                cleanupMessagingData();
            });
        };
    }, []);

    /**
     * Handles a new conversation.
     *
     * 1. Fetch an Unauthenticated Access Token i.e. Messaging JWT.
     * 2. Create a new conversation.
     * @returns {Promise}
     */
    function handleNewConversation() {
        return handleGetUnauthenticatedJwt()
                .then(() => {
                    return handleCreateNewConversation()
                            .then(() => {
                                console.log(`Completed initializing a new conversation with conversationId: ${getConversationId()}`);
                            });
                });
    }

    /**
     * Handles an existing conversation.
     *
     * 1. Fetch a Continuation Access Token i.e. Messaging JWT.
     * 2. Lists the available conversations and loads the current (also most-recent) conversation that is OPEN.
     * 3. Fetch the entries for the current conversation.
     * @returns {Promise}
     */
    function handleExistingConversation() {
        return handleGetContinuityJwt()
                .then(() => {
                    return handleListConversations()
                            .then(() => {
                                console.log(`Successfully listed the conversations.`);
                                handleListConversationEntries()
                                .then(console.log(`Successfully retrieved entries for the current conversation: ${getConversationId()}`));
                            });
                });
    }

    /**
     * Handles fetching an Unauthenticated Access Token i.e. Messaging JWT.
     *
     * 1. If a JWT already exists, simply return.
     * 2. Makes a request to Unauthenticated Access Token endpoint.
     * 3. Updates the web storage with the latest JWT.
     * 4. Performs a cleanup - clears messaging data and closes the Messaging Window, if the request is unsuccessful.
     * @returns {Promise}
     */
    function handleGetUnauthenticatedJwt() {
        if (getJwt()) {
            console.warn("Messaging access token (JWT) already exists in the web storage. Discontinuing to create a new Unauthenticated access token.");
            return handleExistingConversation().then(Promise.reject());
        }

        return getUnauthenticatedAccessToken()
                .then((response) => {
                    console.log("Successfully fetched an Unauthenticated access token.");
                    // Parse the response object which includes access-token (JWT), configutation data.
                    if (typeof response === "object") {
                        setJwt(response.accessToken);
                        setItemInWebStorage(STORAGE_KEYS.JWT, response.accessToken);
                        setLastEventId(response.lastEventId);
                        setDeploymentConfiguration(response.context && response.context.configuration);
                    }    
                })
                .catch((err) => {
                    console.error(`Something went wrong in fetching an Unauthenticated access token: ${err && err.message ? err.message : err}`);
                    handleMessagingErrors(err);
                    cleanupMessagingData();
                    props.showMessagingWindow(false);
                });
    }

    /**
     * Handles creating a new conversation.
     *
     * 1. If a conversation is already open, simply return.
     * 2. Generate a new unique conversation-id and initialize in-memory.
     * 3. Makes a request to Create Conversation endpoint.
     * 4. Updates the conversation status internally to OPENED, for the associated components to reactively update.
     * 5. Performs a cleanup - clears messaging data and closes the Messaging Window, if the request is unsuccessful.
     * @returns {Promise}
     */
    function handleCreateNewConversation() {
        if (conversationStatus === CONVERSATION_CONSTANTS.ConversationStatus.OPENED_CONVERSATION) {
            console.warn("Cannot create a new conversation while a conversation is currently open.");
            return Promise.reject();
        }

        // Initialize a new unique conversation-id in-memory.
        storeConversationId(util.generateUUID());
        return createConversation(getConversationId())
                .then(() => {
                    console.log(`Successfully created a new conversation with conversation-id: ${getConversationId()}`);
                    updateConversationStatus(CONVERSATION_CONSTANTS.ConversationStatus.OPENED_CONVERSATION);
                    props.showMessagingWindow(true);
                })
                .catch((err) => {
                    console.error(`Something went wrong in creating a new conversation with conversation-id: ${getConversationId()}: ${err && err.message ? err.message : err}`);
                    handleMessagingErrors(err);
                    cleanupMessagingData();
                    props.showMessagingWindow(false);
                });
    }

    /**
     * Handles fetching a Continuation Access Token i.e. Messaging JWT.
     *
     * 1. Makes a request to Continuation Access Token endpoint.
     * 2. Updates the web storage with the latest JWT.
     * 3. Performs a cleanup - clears messaging data and closes the Messaging Window, if the request is unsuccessful.
     * @returns {Promise}
     */
    function handleGetContinuityJwt() {
        return getContinuityJwt()
                .then((response) => {
                    setJwt(response.accessToken);
                    setItemInWebStorage(STORAGE_KEYS.JWT, response.accessToken);
                })
                .catch((err) => {
                    console.error(`Something went wrong in fetching a Continuation Access Token: ${err && err.message ? err.message : err}`);
                    handleMessagingErrors(err);
                });
    }

    /**
     * Handles fetching a list of all conversations available. This returns only conversations which are OPEN, unless otherwise specified in the request.
     *
     * 1. Makes a request to List Conversations endpoint.
     * 2. If there are multiple OPEN conversations, loads the conversation with the most-recent start time.
     * 3. Performs a cleanup - clears messaging data and closes the Messaging Window, if the request is unsuccessful.
     * @returns {Promise}
     */
    function handleListConversations() {
        return listConversations()
                .then((response) => {
                    if (response && response.openConversationsFound > 0 && response.conversations.length) {
                        const openConversations = response.conversations;
                        if (openConversations.length > 1) {
				            console.warn(`Expected the user to be participating in 1 open conversation but instead found ${openConversations.length}. Loading the conversation with latest startTimestamp.`);
				            openConversations.sort((conversationA, conversationB) => conversationB.startTimestamp - conversationA.startTimestamp);
                        }
                        // Update conversation-id with the one from service.
                        storeConversationId(openConversations[0].conversationId);
                        updateConversationStatus(CONVERSATION_CONSTANTS.ConversationStatus.OPENED_CONVERSATION);
                        props.showMessagingWindow(true);
                    } else {
                        // No open conversations found.
                        cleanupMessagingData();
                        props.showMessagingWindow(false);
                    }
                })
                .catch((err) => {
                    console.error(`Something went wrong in fetching a list of conversations: ${err && err.message ? err.message : err}`);
                    handleMessagingErrors(err);
                });
    }

    /**
     * Handles fetching a list of all conversation entries for the current conversation.
     *
     * 1. Makes a request to List Conversation Entries endpoint.
     * 2. Renders the conversation entries based on their Entry Type.
     * @returns {Promise}
     */
    function handleListConversationEntries() {
        return listConversationEntries(getConversationId())
                .then((response) => {
                    if (Array.isArray(response)) {
                        response.reverse().forEach(entry => {
                            const conversationEntry = generateConversationEntryForCurrentConversation(entry);
                            if (!conversationEntry) {
                                return;
                            }
    
                            switch (conversationEntry.entryType) {
                                case CONVERSATION_CONSTANTS.EntryTypes.CONVERSATION_MESSAGE:
                                    conversationEntry.isEndUserMessage = ConversationEntryUtil.isMessageFromEndUser(conversationEntry);
                                    addConversationEntry(conversationEntry);
                                    break;
                                case CONVERSATION_CONSTANTS.EntryTypes.PARTICIPANT_CHANGED:
                                case CONVERSATION_CONSTANTS.EntryTypes.ROUTING_RESULT:
                                    addConversationEntry(conversationEntry);
                                    break;
                                default:
                                    console.log(`Unrecognized conversation entry type: ${conversationEntry.entryType}.`);
                            }
                        });
                    } else {
                        console.error(`Expecting a response of type Array from listConversationEntries but instead received: ${response}`);
                    }
                })
                .catch((err) => {
                    console.error(`Something went wrong while processing entries from listConversationEntries response:  ${err && err.message ? err.message : err}`);
                    handleMessagingErrors(err);
                });
    }

    /**
     * Handles establishing a connection to the EventSource i.e. SSE.
     * Selectively listens to the supported events in the app by adding the corresponding event listeners.
     * Note: Update the list of events/event-listeners to add/remove support for the available events. Refer https://developer.salesforce.com/docs/service/messaging-api/references/about/server-sent-events-structure.html
     * @returns {Promise}
     */
    function handleSubscribeToEventSource() {
        return subscribeToEventSource({
                    [CONVERSATION_CONSTANTS.EventTypes.CONVERSATION_MESSAGE]: handleConversationMessageServerSentEvent,
                    [CONVERSATION_CONSTANTS.EventTypes.CONVERSATION_ROUTING_RESULT]: handleRoutingResultServerSentEvent,
                    [CONVERSATION_CONSTANTS.EventTypes.CONVERSATION_PARTICIPANT_CHANGED]: handleParticipantChangedServerSentEvent,
                    [CONVERSATION_CONSTANTS.EventTypes.CONVERSATION_CLOSE_CONVERSATION]: handleCloseConversationServerSentEvent
                })
                .then(() => {
                    console.log("Subscribed to the Event Source (SSE).");
                })
                .catch((err) => {
                    handleMessagingErrors(err);
                });
    }

    /**
     * Generate a Conversation Entry object from the server sent event.
     *
     * 1. Create a Conversation Entry object from the parsed event data.
     * 2. Return the Conversation Entry if the conversationEntry is for the current conversation and undefined, otherwise.
     * @param {object} event - Event data payload from server-sent event.
     * @returns {object|undefined}
     */
    function generateConversationEntryForCurrentConversation(parsedEventData) {
        const conversationEntry = ConversationEntryUtil.createConversationEntry(parsedEventData);

        // Handle server sent events only for the current conversation
        if (parsedEventData.conversationId === getConversationId()) {
            return conversationEntry;
        }
        console.log(`Current conversation-id: ${getConversationId()} does not match the conversation-id in server sent event: ${parsedEventData.conversationId}. Ignoring the event.`);
        return undefined;
    }

    /**
     * Adds a Conversation Entry object to the list of conversation entries. Updates the state of the list of conversation entries for the component(s) to be updated in-turn, reactively.
     * @param {object} conversationEntry - entry object for the current conversation.
     */
    function addConversationEntry(conversationEntry) {
        conversationEntries.push(conversationEntry);
        setConversationEntries([...conversationEntries]);
    }

    /**
     * Handle a CONVERSATION_MESSAGE server-sent event.
     *
     * This includes:
     *  1. Parse, populate, and create ConversationEntry object based on its entry type
     *      NOTE: Skip processing CONVERSATION_MESSAGE if the newly created ConversationEntry is undefined or invalid or not from the current conversation.
     *  2. Updates in-memory list of conversation entries and the updated list gets reactively passed on to MessagingBody.
     * @param {object} event - Event data payload from server-sent event.
     */
    function handleConversationMessageServerSentEvent(event) {
        try {
            console.log(`Successfully handling conversation message server sent event.`);
            // Update in-memory to the latest lastEventId
            if (event && event.lastEventId) {
                setLastEventId(event.lastEventId);
            }

            const parsedEventData = ConversationEntryUtil.parseServerSentEventData(event);
            const conversationEntry = generateConversationEntryForCurrentConversation(parsedEventData);
            if (!conversationEntry) {
                return;
            }

            if (ConversationEntryUtil.isMessageFromEndUser(conversationEntry)) {
                conversationEntry.isEndUserMessage = true;
                console.log(`End user successfully sent a message.`);
            } else {
                conversationEntry.isEndUserMessage = false;
                console.log(`Successfully received a message from ${conversationEntry.actorType}`);
            }

            addConversationEntry(conversationEntry);
        } catch(err) {
            console.error(`Something went wrong in handling conversation message server sent event: ${err}`);
        }
    }

    /**
     * Handle a ROUTING_RESULT server-sent event.
     *
     * This includes:
     *  1. Parse, populate, and create ConversationEntry object based on its entry type.
     *      NOTE: Skip processing ROUTING_RESULT if the newly created ConversationEntry is undefined or invalid or not from the current conversation.
     *  2. Updates in-memory list of conversation entries and the updated list gets reactively passed on to MessagingBody.
     *
     *  NOTE: Update the chat client based on the latest routing result. E.g. if the routing type is transfer, set an internal flag like `isTransferring` to 'true' and use that to show a transferring indicator in the ui.
     * @param {object} event - Event data payload from server-sent event.
     */
    function handleRoutingResultServerSentEvent(event) {
        try {
            console.log(`Successfully handling routing result server sent event.`);
            // Update in-memory to the latest lastEventId
            if (event && event.lastEventId) {
                setLastEventId(event.lastEventId);
            }

            const parsedEventData = ConversationEntryUtil.parseServerSentEventData(event);
            const conversationEntry = generateConversationEntryForCurrentConversation(parsedEventData);
            if (!conversationEntry) {
                return;
            }

            if (conversationEntry.messageType === CONVERSATION_CONSTANTS.RoutingTypes.INITIAL) {
                // Render reasonForNotRouting when initial routing fails.
                switch (conversationEntry.content.failureType) {
                    case CONVERSATION_CONSTANTS.RoutingFailureTypes.NO_ERROR:
                    case CONVERSATION_CONSTANTS.RoutingFailureTypes.SUBMISSION_ERROR:
                    case CONVERSATION_CONSTANTS.RoutingFailureTypes.ROUTING_ERROR:
                    case CONVERSATION_CONSTANTS.RoutingFailureTypes.UNKNOWN_ERROR:
                        addConversationEntry(conversationEntry);
                        break;
                    default:
                        console.error(`Unrecognized initial routing failure type: ${conversationEntry.content.failureType}`);
                }
                // Handle when a conversation is being transferred.
            } else if (conversationEntry.messageType === CONVERSATION_CONSTANTS.RoutingTypes.TRANSFER) {
                switch (conversationEntry.content.failureType) {
                    case CONVERSATION_CONSTANTS.RoutingFailureTypes.NO_ERROR:
                        // Render transfer timestamp when transfer is requested successfully.
                        // TODO: Add a transfer state ui update.
                        addConversationEntry(conversationEntry);
                        break;
                    case CONVERSATION_CONSTANTS.RoutingFailureTypes.SUBMISSION_ERROR:
                    case CONVERSATION_CONSTANTS.RoutingFailureTypes.ROUTING_ERROR:
                    case CONVERSATION_CONSTANTS.RoutingFailureTypes.UNKNOWN_ERROR:
                        break;
                    default:
                        console.error(`Unrecognized transfer routing failure type: ${conversationEntry.content.failureType}`);
                }
            } else {
                console.error(`Unrecognized routing type: ${conversationEntry.messageType}`);
            }
        } catch (err) {
            console.error(`Something went wrong in handling routing result server sent event: ${err}`);
        }
    }

    /**
     * Handle a PARTICIPANT_CHANGED server-sent event.
     *
     * This includes:
     *  1. Parse, populate, and create ConversationEntry object based on its entry type.
     *      NOTE: Skip processing PARTICIPANT_CHANGED if the newly created ConversationEntry is undefined or invalid or not from the current conversation.
     *  2. Updates in-memory list of conversation entries and the updated list gets reactively passed on to MessagingBody.
     * @param {object} event - Event data payload from server-sent event.
     */
    function handleParticipantChangedServerSentEvent(event) {
        try {
            console.log(`Successfully handling participant changed server sent event.`);
            // Update in-memory to the latest lastEventId
            if (event && event.lastEventId) {
                setLastEventId(event.lastEventId);
            }

            const parsedEventData = ConversationEntryUtil.parseServerSentEventData(event);
            const conversationEntry = generateConversationEntryForCurrentConversation(parsedEventData);
            if (!conversationEntry) {
                return;
            }
            addConversationEntry(conversationEntry);
        } catch (err) {
            console.error(`Something went wrong in handling participant changed server sent event: ${err}`);
        }
    }

    /**
     * Handle a CONVERSATION_CLOSED server-sent event.
     *
     * @param {object} event - Event data payload from server-sent event.
     */
    function handleCloseConversationServerSentEvent(event) {
        try {
            console.log(`Successfully handling close conversation server sent event.`);
            // Update in-memory to the latest lastEventId
            if (event && event.lastEventId) {
                setLastEventId(event.lastEventId);
            }

            const parsedEventData = ConversationEntryUtil.parseServerSentEventData(event);

            // Do not render conversation ended text if the conversation entry is not for the current conversation.
            if (getConversationId() === parsedEventData.conversationId) {
                // Update state to conversation closed status.
                updateConversationStatus(CONVERSATION_CONSTANTS.ConversationStatus.CLOSED_CONVERSATION);
            }
        } catch (err) {
            console.error(`Something went wrong while handling conversation closed server sent event in conversation ${getConversationId()}: ${err}`);
        }
    }

    /**
     * Update conversation status state based on the event from a child component i.e. MessagingHeader.
     * Updating conversation status state re-renders the current component as well as the child components and the child components can reactively use the updated conversation status to make any changes.
     *
     * @param {string} status - e.g. CLOSED.
     */
    function updateConversationStatus(status) {
        setConversationStatus(status);
    }

    /**
     * Close messaging window handler for the event from a child component i.e. MessagingHeader.
     * When such event is received, invoke the parent's handler to close the messaging window if the conversation status is closed or not yet started.
     */
    function endConversation() {
        if (conversationStatus === CONVERSATION_CONSTANTS.ConversationStatus.OPENED_CONVERSATION) {
            // End the conversation if it is currently opened.
            return closeConversation(getConversationId())
                .then(() => {
                    console.log(`Successfully closed the conversation with conversation-id: ${getConversationId()}`);
                })
                .catch((err) => {
                    console.error(`Something went wrong in closing the conversation with conversation-id ${getConversationId()}: ${err}`);
                })
                .finally(() => {
                    cleanupMessagingData();
                });
        }
    }

    /**
     * Close messaging window handler for the event from a child component i.e. MessagingHeader.
     * When such event is received, invoke the parent's handler to close the messaging window if the conversation status is closed or not yet started.
     */
    function closeMessagingWindow() {
        if (conversationStatus === CONVERSATION_CONSTANTS.ConversationStatus.CLOSED_CONVERSATION || conversationStatus === CONVERSATION_CONSTANTS.ConversationStatus.NOT_STARTED_CONVERSATION) {
            props.showMessagingWindow(false);
        }
    }

    /**
     * Performs a cleanup in the app.
     * 1. Closes the EventSource connection.
     * 2. Clears the web storage.
     * 3. Clears the in-memory messaging data.
     * 4. Update the internal conversation status to CLOSED.
     */
    function cleanupMessagingData() {
        closeEventSource()
        .then(console.log("Closed the Event Source (SSE)."))
        .catch((err) => {
            console.error(`Something went wrong in closing the Event Source (SSE): ${err}`);
        });

        clearWebStorage();
        clearInMemoryData();

        // Update state to conversation closed status.
        updateConversationStatus(CONVERSATION_CONSTANTS.ConversationStatus.CLOSED_CONVERSATION);
    }

     /**
     * Handles the errors from messaging endpoint requests.
     * If a request is failed due to an Unauthorized error (i.e. 401), peforms a cleanup and resets the app and console logs otherwise.
     */
    function handleMessagingErrors(err) {
        if (typeof err === "object") {
            if (err.status) {
                switch (err.status) {
                    case 401:
                        console.error(`Unauthenticated request: ${err.message}`);
                        cleanupMessagingData();
                        props.showMessagingWindow(false);
                        break;
                    case 400:
                        console.error(`Invalid request parameters. Please check your data before retrying: ${err.message}`);
                        break;
                    case 429:
                        console.warn(`Too many requests issued from the app. Try again in sometime: ${err.message}`);
                        break;
                    case 500:
                        console.error(`Something went wrong in the request, please try again: ${err.message}`);
                        break;
                    default:
                        console.error(`Unhandled/Unknown http error: ${err}`);
                        cleanupMessagingData();
                        props.showMessagingWindow(false);
                }
                return;
            }
            console.error(`Something went wrong: ${err && err.message ? err.message : err}`);
        }
        return;
    }

    return (
        <>
            <MessagingHeader
                conversationStatus={conversationStatus}
                endConversation={endConversation}
                closeMessagingWindow={closeMessagingWindow} />
            <MessagingBody
                conversationEntries={conversationEntries}
                conversationStatus={conversationStatus} />
            <MessagingInputFooter
                conversationStatus={conversationStatus} 
                sendTextMessage={sendTextMessage} />
        </>
    );
}