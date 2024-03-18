// this is the main bit of the recipe shopping app with referral links
require('dotenv').config({
    path: require('find-config')('.env')
});


const { PineconeStore } = require("@langchain/community/vectorstores/pinecone");
const { OpenAIEmbeddings, ChatOpenAI } = require("@langchain/openai");
const { formatDocumentsAsString } = require("langchain/util/document");
const { PromptTemplate } = require("@langchain/core/prompts");
const { StringOutputParser } = require("@langchain/core/output_parsers");
const { RunnableSequence } = require("@langchain/core/runnables");
const { BufferWindowMemory } = require("langchain/memory");
const { StructuredOutputParser } = require("langchain/output_parsers");
const { z } = require("zod");
const fs = require('fs/promises');
const path = require('path');
const { PDFLoader } = require("langchain/document_loaders/fs/pdf");
const { Pinecone } =  require("@pinecone-database/pinecone");
const { ChatMessageHistory } = require("langchain/memory");
const DDG = require('duck-duck-scrape');
const puppeteer = require('puppeteer');
const querystring = require('node:querystring');

const getProductAttribute = async (fetchProduct, selector, ignoreInnerText = false) => {
    return await fetchProduct.evaluate((product, selector, ignoreInnerText) => {
        const base_selector = product.querySelector(selector);

        if (ignoreInnerText) {
            return base_selector;
        }

        return base_selector?.innerText
    }, selector, ignoreInnerText)
}

function partition(array, n) {
    return array.length ? [array.splice(0, n)].concat(partition(array, n)) : [];
}

const getProducts = async query => {
    const browser = await puppeteer.launch({
        headless: "new"
    })
  
    const page = await browser.newPage()
  
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36',
    );
  
    await page.goto(`https://naivas.online/kiambu-road/module/ambjolisearch/jolisearch?${querystring.stringify({s: query})}`)
  

    const fetchedProducts = await page.$$('.product-miniature');

    const products = [];

    for (const product of fetchedProducts) {
        const name = await getProductAttribute(
            product,
            '.product-name a'
        );

        if (!name) {
            continue;
        }

        products.push({
            name,

            price: await getProductAttribute(
                product,
                '.price.product-price'
            ),

            availability: await getProductAttribute(
                product,
                '.available'
            ),

            // image: (await getProductAttribute(
            //     product,
            //     'src', true
            // ))?.getAttribute('src'),

            // link: (await getProductAttribute(
            //     product,
            //     '.product-cover-link', true
            // ))?.getAttribute('href')
        })
    }

    await browser.close();

    return products?.[0];
  }

// build the indices right heere
const pinecone = new Pinecone({
    environment: process.env.PINECONE_ENVIRONMENT,      
    apiKey: process.env.PINECONE_API_KEY,
});

const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX);
const pineconeStore = new PineconeStore(new OpenAIEmbeddings({
    openAIApiKey: process.env.OPENAI_API_KEY,
}), { 
    pineconeIndex: pinecone.Index(process.env.PINECONE_INDEX), 
    maxConcurrency: 5
});

const parser = StructuredOutputParser.fromZodSchema(
    z.array(
        z.object({
            name: z.string().describe('Ingredient name'),
            amount: z.string().describe('Ingredient amount')
        })
    ).describe('arrays of ingredients')
);


/**
 * 
 * @param {string} ingredient 
 * @returns {string}
 */
async function get_ingredients_images(ingredient) {
    const results = await DDG.searchImages(ingredient, {
        safeSearch: DDG.SafeSearchType.MODERATE,
    });

    return results?.results[0]?.image;
}

class FoodieAutoShoppingAI {
    constructor() {
        // this will be the document ids to use in the filter
        this.llm_chat = new ChatOpenAI({
            temperature: 0.5,
            openAIApiKey: process.env.OPENAI_API_KEY,
            modelName: 'gpt-4-1106-preview',
            streaming: true
        });
    }

    // vectorize any document passed
    /**
     * 
     * @param {string} folder 
     */
    static async vectorize_documents(folder) {
        // vectorize it and then will be used for querying
        const { fileTypeFromFile } = await import('file-type');

        const files = await fs.readdir(folder);
        let documents = [];

        for (const file of files) {
            const absolute_file_path = path.join(folder, file);
            const file_stat = await fs.stat(absolute_file_path);

            if (file_stat.isFile()) {
                // and is a PDF then vectorize it
                const { mime } = await fileTypeFromFile(absolute_file_path);

                if (mime === 'application/pdf') {
                    const loader = new PDFLoader(new Blob([await fs.readFile(absolute_file_path)]), {
                        splitPages: true
                    });

                    documents.push(await loader.load())
                }
            }
        }

        documents = documents.flat();
        await pineconeStore.addDocuments(documents);
    }

    // take the generated recipee, get the ingerients and then search for the ingredients in our partners websites
    // get the prices and redirect them to that app if possible --> we dont want to deal with the whole setup flows
    // start with green spoon
    /**
     * 
     * @param {string} recipee 
     */
    async generate_shopping_plan(recipee) {
        // extract the ingridients
        const model = new ChatOpenAI({ 
            temperature: 0,
            modelName: 'gpt-4-1106-preview',
            openAIApiKey: process.env.OPENAI_API_KEY 
        });

        const prompt = new PromptTemplate({
            template:
                "Answer the users question as best as possible.\n{format_instructions}\n{question}",
            inputVariables: ["question"],
            partialVariables: { format_instructions: parser.getFormatInstructions() },
        });

        const input = await prompt.format({ question: recipee });

        const ingredients = await parser.parse(await model.predict(input));

        // get the images --> also try to find the best places to shop

        // for (const ingredient of ingredients) {
        //     const image = await get_ingredients_images(`raw or uncooked fresh ${ingredient.name}`);
        //     ingredient.image = image;
        // }

        // now how tf are we gonna search for this stuff
        // get purchase links

        return {
            recipee,
            ingredients
        };
    }

    // we have a stream part and a normal part -> takes the generated recipe and tries to resolve the items from our providers
    // we also need to add images -- should we stream this
    async chat(query, on_chunk_callback, on_generation_end) {
        const vector_store = new PineconeStore(new OpenAIEmbeddings({
            openAIApiKey: process.env.OPENAI_API_KEY,
        }),{ 
            pineconeIndex: pineconeIndex, 
            maxConcurrency: 5
        });

        const retriever = vector_store.asRetriever({
            distance: 0,
            k: 10,
        })

        const questionPrompt = PromptTemplate.fromTemplate(
            `Use the following pieces of context to answer the question at the end. If you don't know the answer, just say that you don't know, don't try to make up an answer.
          ----------
          CONTEXT: {context}
          ----------
          CHAT HISTORY: {chatHistory}
          ----------
          QUESTION: {question}
          ----------
          Helpful Answer:`
        );
          
        const memory = new BufferWindowMemory({ 
            chatHistory: new ChatMessageHistory([]), 
            memoryKey: 'chat_history',
            k: 5,
            returnMessages: true
        });

        const chain = RunnableSequence.from([
            {
                question: (input) =>    input.question,
                memory: () => memory.loadMemoryVariables({}),
                
                chatHistory: (input) => {
                    return input.chatHistory ?? ""
                },

                context: async (input) => {
                    const relevantDocs = await retriever.getRelevantDocuments(input.question);
                    const serialized = formatDocumentsAsString(relevantDocs);
                    return serialized;
                },  
            },
            questionPrompt,
            this.llm_chat,
            new StringOutputParser(),
        ]);
        
        const stream = await chain.stream({ question: query });
        
        let streamedResult = "";

        for await (const chunk of stream) {
            streamedResult += chunk;
            on_chunk_callback(streamedResult);
        }

        await on_generation_end(streamedResult);
    }
}

;(async () => {
    // await FoodieAutoShoppingAI.vectorize_documents('./recipes');
    const bot = new FoodieAutoShoppingAI();

    await bot.chat("Lamb Batna recipe", (response) => {
        console.clear();
        console.log(response);
    }, async response => {
        if (response) {
            const { recipee, ingredients } = await bot.generate_shopping_plan(response);

            let local_ingredients = [];

            for (const ingredient of partition(ingredients, 2)) {
                local_ingredients.push(
                    (
                        await Promise.allSettled(
                            ingredient.map(
                                async ({ name, ...rest }) => {
                                    return {
                                        name,
                                        ...rest,
                                        naivas_listing: await getProducts(name)
                                    }
                                }
                            )
                        )
                    )?.map(({ value }) => value)?.filter(u => u)
                )
            }

            local_ingredients = local_ingredients.flat();

            console.log(JSON.stringify({
                recipee,
                ingredients: local_ingredients,
                total_cost: local_ingredients.reduce((acc, x) => {
                    return {
                        ...acc,
                        total: acc.total + +x?.naivas_listing?.price?.replace('KES', '')?.replaceAll(",","").trim()
                    }
                }, { total: 0, currency: 'KES' })
            }, null, 2))
        }
    });

    // await getProducts("minced ginger")
})();


module.exports = { FoodieAutoShoppingAI }