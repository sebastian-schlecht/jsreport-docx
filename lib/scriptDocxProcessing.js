const util = require('util')
const { DOMParser, XMLSerializer } = require('xmldom')
const decodeXML = require('unescape')
const { decompress, saveXmlsToOfficeFile } = require('jsreport-office')
const preprocess = require('./preprocess/preprocess.js')
const postprocess = require('./postprocess/postprocess.js')
const { contentIsXML } = require('./utils')

module.exports = async function scriptDocxProcessing (inputs, callback, done) {
  const callbackAsync = util.promisify(callback)
  const { docxTemplateContent, outputPath } = inputs
  let logs = []

  const renderCallback = async (content) => {
    const renderContent = await callbackAsync({
      content,
      // we send current logs to callback to keep correct order of
      // logs in request, after the callback is done we empty the logs again
      // (since they were added in the callback code already)
      logs
    }).then((r) => {
      logs = []
      return r
    }).catch((e) => {
      logs = []
      throw e
    })

    return renderContent
  }

  function log (level, ...args) {
    logs.push({
      timestamp: new Date().getTime(),
      level: level,
      message: util.format.apply(util, args)
    })
  }

  try {
    const files = await decompress()(docxTemplateContent)

    for (const f of files) {
      f.unescapeNodes = []
      if (contentIsXML(f.data)) {
        f.doc = new DOMParser().parseFromString(f.data.toString())
        f.data = f.data.toString()
      }
    }

    await preprocess(files)

    const filesToRender = files.filter(f => contentIsXML(f.data))

    const contentToRender = filesToRender.map(f => {
      const xmlStr = new XMLSerializer().serializeToString(f.doc, undefined, (node) => {
        if (node.nodeType === 2 && node.nodeValue && node.nodeValue.includes('{{')) {
          const str = new XMLSerializer().serializeToString(node)
          return decodeXML(str)
        }

        return node
      })

      return xmlStr.replace(/<docxRemove>/g, '').replace(/<\/docxRemove>/g, '')
    }).join('$$$docxFile$$$')

    log('debug', `Starting child request to render docx dynamic parts`)

    const { content: newContent } = await renderCallback(contentToRender)

    const contents = newContent.split('$$$docxFile$$$')

    for (let i = 0; i < filesToRender.length; i++) {
      filesToRender[i].data = contents[i]
      if (filesToRender[i].path !== 'word/document.xml') {
        filesToRender[i].doc = new DOMParser().parseFromString(contents[i])
      }
    }

    await postprocess(files)

    for (const f of files) {
      if (contentIsXML(f.data) && f.path !== 'word/document.xml') {
        f.data = Buffer.from(new XMLSerializer().serializeToString(f.doc))
      }
    }

    await saveXmlsToOfficeFile({
      outputPath,
      files
    })

    log('debug', 'docx successfully zipped')

    done(null, {
      logs,
      docxFilePath: outputPath
    })
  } catch (e) {
    done(null, {
      logs,
      error: {
        message: e.message,
        stack: e.stack
      }
    })
  }
}
