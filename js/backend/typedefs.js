// Same GraphQL schema as the server versions, plus two demo-only mutations.
export const typeDefs = /* GraphQL */ `
  type Query {
    me: User
    config: Config!
    cities: [City!]!
    allCities: [City!]!
    city(slug: String!): City
    cityRecs(slug: String!, plannedHour: String): CityRecs!
    rec(id: ID!): Rec
    popular: [PopularItem!]!
    pass: Pass
    walkingRoute(points: [PointInput!]!): Route!
    moderation(slug: String!): Moderation!
  }

  type Mutation {
    register(email: String!, password: String!, name: String!): User!
    login(email: String!, password: String!): User!
    logout: Boolean!
    updateProfile(name: String, interests: [String!], budget: String): User!
    becomeRecommender(homeCity: String!, localSince: Int!): User!
    buy(kind: String!, citySlug: String): PurchaseResult!
    unlockCity(slug: String!, using: String!): User!
    redeemCreditsForMonth: User!
    vote(recId: ID!, value: Int!): Rec!
    stampVisit(recId: ID!, note: String): Pass!
    addVisit(input: VisitInput!): Pass!
    removeVisit(id: ID!): Pass!
    planVisit(recId: ID!, hour: String!): Rec!
    createRec(input: RecInput!): Rec!
    report(recId: ID!, reason: String!, text: String): Boolean!
    reviewRec(recId: ID!, action: String!, note: String): Rec!
    handleReport(id: ID!, action: String!): Boolean!
    setCapacity(recId: ID!, capacity: Int!): Rec!
    appointModerator(slug: String!, email: String!): City!
    createCity(input: CityInput!): City!
    makeMeModerator(slug: String!): User!
    resetDemo: Boolean!
  }

  type Config { paymentsMode: String!, moods: [String!]!, budgets: [String!]!, tileUrl: String!, tileAttribution: String! }

  type User {
    id: ID!
    name: String!
    email: String!
    isAdmin: Boolean!
    interests: [String!]!
    budget: String!
    homeCity: String
    localSince: Int
    isRecommender: Boolean!
    credits: Int!
    passTokens: Int!
    subscriptionUntil: String
    hasSubscription: Boolean!
    unlockedCities: [String!]!
    moderatorOf: [City!]!
    rewards: Rewards!
  }
  type Rewards { tier: String!, points: Float!, nextTier: String, pointsNeeded: Int, approved: Int! }
  type PublicUser { id: ID!, name: String!, homeCity: String, localSince: Int }

  type City {
    id: ID!
    slug: String!
    name: String!
    country: String!
    countryId: String!
    continent: String!
    region: String!
    lat: Float!
    lng: Float!
    zoom: Float!
    isOpen: Boolean!
    recCount: Int!
    walkCount: Int!
    moderators: [PublicUser!]!
    hasAccess: Boolean!
  }

  type Point { lat: Float!, lng: Float! }
  input PointInput { lat: Float!, lng: Float! }
  type Stop { name: String!, description: String!, priceLevel: Int!, lat: Float, lng: Float }
  input StopInput { name: String!, description: String, priceLevel: Int, lat: Float!, lng: Float! }

  type Rec {
    id: ID!
    kind: String!
    title: String!
    description: String!
    personalRating: Int!
    priceLevel: Int!
    category: String!
    moods: [String!]!
    bestTime: String!
    photoUrl: String!
    location: Point!
    path: [[Float!]!]!
    stops: [Stop!]!
    distanceKm: Float!
    durationMin: Int!
    snapped: Boolean!
    author: PublicUser
    citySlug: String!
    up: Int!
    down: Int!
    score: Float!
    opacity: Float!
    myVote: Int!
    busy: String
    capacity: Int!
    status: String!
    reviewNote: String!
  }
  type CityRecs { city: City!, access: Boolean!, recs: [Rec!]!, preview: Rec }
  type Route { path: [[Float!]!]!, distanceKm: Float!, durationMin: Int!, snapped: Boolean!, provider: String!, problem: String! }
  type Visit { id: ID!, countryId: String!, countryName: String!, cityName: String!, lat: Float, lng: Float, source: String!, date: String!, note: String!, place: String }
  type Pass { visits: [Visit!]!, countries: Int!, cities: Int!, places: Int! }
  type PopularItem { kind: String!, title: String!, meta: String!, citySlug: String! }
  type ReportItem { id: ID!, reason: String!, text: String!, status: String!, recTitle: String!, recId: ID! }
  type Moderation { city: City!, pending: [Rec!]!, reports: [ReportItem!]!, live: [Rec!]!, approvedCount: Int! }
  type PurchaseResult { granted: Boolean!, checkoutUrl: String, mode: String!, me: User }

  input VisitInput { countryId: String!, countryName: String!, cityName: String, lat: Float, lng: Float, date: String, note: String }
  input RecInput {
    citySlug: String!
    kind: String!
    title: String!
    description: String!
    personalRating: Int!
    priceLevel: Int!
    category: String
    moods: [String!]
    bestTime: String
    photoUrl: String
    location: PointInput!
    destination: PointInput
    waypoints: [PointInput!]
    stops: [StopInput!]
  }
  input CityInput { slug: String!, name: String!, country: String!, countryId: String!, continent: String!, region: String!, lat: Float!, lng: Float!, zoom: Float }
`;
