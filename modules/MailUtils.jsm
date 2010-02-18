var EXPORTED_SYMBOLS = ['getMessageBody', 'selectRightMessage',
  'removeDuplicates', 'MimeMessageToHTML', 'MimeMessageHasAttachment',
  'convertHotmailQuotingToBlockquote1', 'convertHotmailQuotingToBlockquote2',
  'convertOutlookQuotingToBlockquote', '_mm_toggleClass',
  'convertForwardedToBlockquote']

const Ci = Components.interfaces;
const Cc = Components.classes;
const Cu = Components.utils;
Components.utils.import("resource://app/modules/gloda/mimemsg.js");
/* from mailnews/base/public/nsMsgFolderFlags.idl */
const nsMsgFolderFlags_SentMail = 0x00000200;
const nsMsgFolderFlags_Archive  = 0x00004000;

const txttohtmlconv = Cc["@mozilla.org/txttohtmlconv;1"].createInstance(Ci.mozITXTToHTMLConv);

/* Do a "old-style" retrieval of a message's body given its nsIMsgDBHdr. This
 * is useful when MsgHdrToMimeMessage fails. */
function getMessageBody(aMessageHeader, aStripHtml) {  
  let messenger = Cc["@mozilla.org/messenger;1"].createInstance(Ci.nsIMessenger);  
  let listener = Cc["@mozilla.org/network/sync-stream-listener;1"].createInstance(Ci.nsISyncStreamListener);  
  let uri = aMessageHeader.folder.getUriForMsg(aMessageHeader);  
  messenger.messageServiceFromURI(uri).streamMessage(uri, listener, null, null, false, "");  
  let folder = aMessageHeader.folder;  
  /*
   * AUTF8String getMsgTextFromStream(in nsIInputStream aStream, in ACString aCharset,
                                      in unsigned long aBytesToRead, in unsigned long aMaxOutputLen, 
                                      in boolean aCompressQuotes, in boolean aStripHTMLTags,
                                      out ACString aContentType);
  */
  return folder.getMsgTextFromStream(listener.inputStream, aMessageHeader.Charset, 65536, 32768, false, aStripHtml, { });  
}  

/* In the case of GMail accounts, several messages with the same Message-Id
 * header will be returned when we search for all message related to the
 * conversation we will display. We have multiple alternatives to choose from,
 * so prefer :
 * - the message that's in the current folder
 * - the message that's in the "Sent" folder (GMail sent messages also appear
 *   in "All Mail")
 * - the message that's not in the Archives
 */
function selectRightMessage(similar, currentFolder) {
  let msgHdr;
  /* NB: this won't find anything for the "Inbox" Smart Folder for instance */
  for each (let m in similar) {
    if (currentFolder && m.folderMessage.folder.URI == currentFolder.URI) {
      msgHdr = m;
      break;
    }
  }
  if (!msgHdr) {
    for each (let m in similar) {
      if (m.folderMessage.folder.getFlag(nsMsgFolderFlags_SentMail)) {
        msgHdr = m;
        break;
      }
    }
  }
  if (!msgHdr) {
    for each (let m in similar) {
      if (!m.folderMessage.folder.getFlag(nsMsgFolderFlags_Archive)) {
        msgHdr = m;
        break;
      }
    }
  }
  if (!msgHdr)
    msgHdr = similar[0];
  return msgHdr;
}

/* Remove messages with the same Message-Id header from a collection.
 * Return an object with, for each message in selectedMessages, the duplicates
 * that have been found. */
function removeDuplicates(items) {
  //let info = function (hdr) hdr.mime2DecodedAuthor+" ["+hdr.mime2DecodedSubject+"]";
  let similar = {};
  let orderedIds = [];
  for (let i = 0; i < items.length; ++i) {
    let item = items[i];
    let id = item.headerMessageID;
    if (!similar[id]) {
      similar[id] = [item];
      orderedIds.push(id);
    } else {
      similar[id].push(item);
    }
  }
  return [similar[id] for each (id in orderedIds)];
}

/* Recursively walk down a MimeMessage trying to find a text/html MessageBody.
 * TODO: figure out a way to use else if (aMsg instanceof MimeMsg) instead of
 * that stupid test with toString below. */
function MimeMessageToHTML(aMsg) {
  if (aMsg instanceof MimeMessage || aMsg instanceof MimeContainer) { // is this a container ?
    let buf = [];
    let buf_i = 0;
    for each (p in aMsg.parts) {
      let [isHtml, html] = MimeMessageToHTML(p);
      if (isHtml)
        buf[buf_i++] = html;
    }
    if (buf_i > 0)
      return [true, buf.join("")];
    else
      return [false, ""]
  } else if (aMsg instanceof MimeBody) { // we only want to examinate bodies
    if (aMsg.contentType == "text/html") {
      /*for (let i in aMsg)
        dump(i+":"+aMsg[i]+"\n");*/
      return [true, aMsg.body];
    } else {
      return [false, ""]; // we fail here
    }
  } else {
    return [false, ""];
  }
}

function MimeMessageHasAttachment(aMsg) {
  let f = function (aMsg) {
    if (aMsg instanceof MimeMessageAttachment)
      throw { found: true };
    else
      [f(x) for each (x in aMsg.parts)];
  };
  try {
    f(aMsg);
    return false;
  } catch (e if e.found) {
    return true;
  }
}

function insertAfter(newElement, referenceElt) {
  if (referenceElt.nextSibling)
    referenceElt.parentNode.insertBefore(newElement, referenceElt.nextSibling);
  else
    referenceElt.parentNode.appendChild(newElement);
}

function makeBlockquote(aDoc, marker, remove) {
  let blockquote = aDoc.createElement("blockquote");
  blockquote.setAttribute("type", "cite");
  insertAfter(blockquote, marker);
  while (blockquote.nextSibling)
    blockquote.appendChild(blockquote.nextSibling);
  if (remove)
    marker.parentNode.removeChild(marker);
}

function convertHotmailQuotingToBlockquote1(aDoc) {
  /* We make the assumption that no one uses a <hr> in their emails except for
   * separating a quoted message from the rest */
  let marker =  aDoc.getElementsByTagName("hr")[0];
  if (marker)
    makeBlockquote(aDoc, marker, true);
}

function convertOutlookQuotingToBlockquote(aDoc) {
  /* Outlook uses a special thing for that */
  let marker = aDoc.getElementsByClassName("OutlookMessageHeader")[0];
  if (marker)
    makeBlockquote(aDoc, marker);
}

function convertHotmailQuotingToBlockquote2(aDocument, aHideQuoteLength) {
  /* Actually that's not specific to Hotmail... */
  let brCount = 0;
  let walk = function (aNode, inBlockquote, depth) {
    let p = Object();
    if (aNode.nodeType == aNode.TEXT_NODE && txttohtmlconv.citeLevelTXT(aNode.textContent+" ", p) > 0) {
      if (!inBlockquote) {
        let blockquote = aDocument.createElement("blockquote");
        blockquote.setAttribute("type", "cite");
        blockquote.setUserData("hideme", false, null);
        aNode.parentNode.insertBefore(blockquote, aNode);
      }
      let next = aNode.nextSibling;
      aNode.previousSibling.appendChild(aNode);
      if (next)
        walk(next, true, depth);
    } else if (aNode.tagName && aNode.tagName.toLowerCase() == "br"
            || aNode.nodeType == aNode.TEXT_NODE && !aNode.textContent.trim().length) {
      let next = aNode.nextSibling;
      if (inBlockquote) {
        if (aNode.tagName && aNode.tagName.toLowerCase() == "br")
          brCount++;
        if (brCount == aHideQuoteLength + 1)
          blockquote.setUserData("hideme", true, null);
        aNode.previousSibling.appendChild(aNode);
      }
      if (next)
        walk(next, inBlockquote, depth);
    } else {
      if (aNode.firstChild && depth < 4) /* Try to mitigate the performance hit... */
        walk(aNode.firstChild, false, depth + 1);
      if (aNode.nextSibling)
        walk(aNode.nextSibling, false, depth);
    }
  };
  walk(aDocument.body, false, 0);
}

function convertForwardedToBlockquote(aDoc) {
  let re = /\s*(-+)\s+(?:\w+\s+)+\1\s*/m;
  let walk = function (aNode) {
    for each (let [, child] in Iterator(aNode.childNodes)) {
      if (child.nodeType == child.TEXT_NODE && re.test(child.textContent)) {
        makeBlockquote(aDoc, child);
        throw { found: true };
      } else {
        walk(child);
      }
    }
  };
  try {
    walk(aDoc.body);
  } catch ( { found } if found) { }
}

/* (no comment) */
function _mm_toggleClass(node, classname) {
  let classes = [];
  if (node.hasAttribute('class'))
    classes = node.getAttribute('class').split(' ');

  if (classes.indexOf(classname) >= 0)
    classes = classes.filter(function (x) x != classname);
  else
    classes.push(classname);
  node.setAttribute('class', classes.join(' '));
}

